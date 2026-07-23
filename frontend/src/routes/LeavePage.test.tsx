import { HttpResponse, http } from "msw";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { makeDoctor, makeLeaveEntry } from "@/test/fixtures/reference";
import { renderWithProviders } from "@/test/renderWithProviders";
import { server } from "@/test/msw/server";

import { LeavePage } from "./LeavePage";

function setUpServer({
  doctors = [makeDoctor({ id: 1, code: "AB", active: true })],
  leave = [] as ReturnType<typeof makeLeaveEntry>[],
} = {}) {
  server.use(
    http.get("/api/v1/doctors", () => HttpResponse.json(doctors)),
    http.get("/api/v1/leave", () => HttpResponse.json(leave)),
  );
}

/**
 * The form's doctor select starts with only "Select..." until the
 * /doctors fetch resolves - selecting an option before then fails with
 * "Value not found in options". Every test that interacts with this
 * select waits for its target option to actually be there first,
 * mirroring the `within(select).findByRole("option", ...)` pattern
 * ClinicTypeFormDialog_test.tsx established for the same race.
 */
async function selectFormDoctor(user: ReturnType<typeof userEvent.setup>, code: string) {
  const select = await screen.findByLabelText("Doctor", { selector: "#leave-range-doctor" });
  const option = await within(select).findByRole("option", { name: code });
  await user.selectOptions(select, option);
  return select;
}

async function typeDates(user: ReturnType<typeof userEvent.setup>, start: string, end: string) {
  await user.type(screen.getByLabelText("Start date", { selector: "#leave-range-start" }), start);
  await user.type(screen.getByLabelText("End date", { selector: "#leave-range-end" }), end);
}

/** A /leave/bulk handler that records bodies and responds with empty results. */
function captureBulkBodies() {
  const bodies: { doctor_id: number; start_date: string; end_date: string; period: string }[] = [];
  server.use(
    http.post("/api/v1/leave/bulk", async ({ request }) => {
      bodies.push((await request.json()) as (typeof bodies)[number]);
      return HttpResponse.json({ created: [], skipped: [], superseded_extra_sessions: [] });
    }),
  );
  return bodies;
}

describe("LeavePage", () => {
  it("shows an empty-state message when there are no entries", async () => {
    setUpServer();
    renderWithProviders(<LeavePage />);

    expect(await screen.findByText("No leave entries.")).toBeInTheDocument();
  });

  it("renders a row per leave entry", async () => {
    setUpServer({ leave: [makeLeaveEntry({ id: 1, doctor_id: 1, date: "2026-08-03", period: "AM" })] });
    renderWithProviders(<LeavePage />);

    const table = await screen.findByRole("table");
    expect(screen.getByText("Mon, 2026-08-03")).toBeInTheDocument();
    expect(within(table).getByText("AB")).toBeInTheDocument();
  });

  it("the doctor filter select includes inactive doctors", async () => {
    setUpServer({ doctors: [makeDoctor({ id: 2, code: "ZZ", active: false })] });
    renderWithProviders(<LeavePage />);

    const filter = await screen.findByLabelText("Doctor", { selector: "#leave-filter" });
    expect(await within(filter).findByRole("option", { name: "ZZ (inactive)" })).toBeInTheDocument();
  });

  it("the form doctor select excludes inactive doctors in both modes", async () => {
    setUpServer({
      doctors: [makeDoctor({ id: 1, code: "AB", active: true }), makeDoctor({ id: 2, code: "ZZ", active: false })],
    });
    const user = userEvent.setup();
    renderWithProviders(<LeavePage />);

    const formSelect = await screen.findByLabelText("Doctor", { selector: "#leave-range-doctor" });
    expect(await within(formSelect).findByRole("option", { name: "AB" })).toBeInTheDocument();
    expect(within(formSelect).queryByRole("option", { name: /ZZ/ })).not.toBeInTheDocument();

    // Deliberate semantics change from the old separate range-delete
    // form, which allowed inactive doctors: the unified form is
    // active-only in Remove mode too (per-row table delete still covers
    // inactive doctors' historical entries).
    await user.click(screen.getByRole("radio", { name: "Remove leave" }));
    expect(within(formSelect).queryByRole("option", { name: /ZZ/ })).not.toBeInTheDocument();
  });

  it("the filter select groups doctors into type optgroups in Partner, Salaried, Trainee, AHP order", async () => {
    setUpServer({
      doctors: [
        makeDoctor({ id: 1, code: "TR1", doctor_type: "Trainee", active: true }),
        makeDoctor({ id: 2, code: "PA1", doctor_type: "Partner", active: true }),
        makeDoctor({ id: 3, code: "SA1", doctor_type: "Salaried", active: true }),
      ],
    });
    renderWithProviders(<LeavePage />);

    const filter = (await screen.findByLabelText("Doctor", {
      selector: "#leave-filter",
    })) as HTMLSelectElement;
    await within(filter).findByRole("option", { name: "PA1" });

    const groupLabels = Array.from(filter.querySelectorAll("optgroup")).map((g) => g.label);
    expect(groupLabels).toEqual(["Partners", "Salaried", "Trainees"]);
  });

  it("the form select groups doctors alphabetically within each type", async () => {
    setUpServer({
      doctors: [
        makeDoctor({ id: 1, code: "LFM", doctor_type: "Partner", active: true }),
        makeDoctor({ id: 2, code: "CL", doctor_type: "Partner", active: true }),
        makeDoctor({ id: 3, code: "DT", doctor_type: "Partner", active: true }),
      ],
    });
    renderWithProviders(<LeavePage />);

    const formSelect = (await screen.findByLabelText("Doctor", {
      selector: "#leave-range-doctor",
    })) as HTMLSelectElement;
    await within(formSelect).findByRole("option", { name: "CL" });

    const group = formSelect.querySelector("optgroup");
    expect(group?.label).toBe("Partners");
    const optionCodes = Array.from(group?.querySelectorAll("option") ?? []).map((o) => o.textContent);
    expect(optionCodes).toEqual(["CL", "DT", "LFM"]);
  });

  it("selecting a doctor in the filter refetches with doctor_id", async () => {
    setUpServer();
    let capturedUrl = "";
    server.use(
      http.get("/api/v1/leave", ({ request }) => {
        capturedUrl = request.url;
        return HttpResponse.json([]);
      }),
    );

    const user = userEvent.setup();
    renderWithProviders(<LeavePage />);
    const filter = await screen.findByLabelText("Doctor", { selector: "#leave-filter" });
    const option = await within(filter).findByRole("option", { name: "AB" });

    await user.selectOptions(filter, option);

    await waitFor(() => expect(capturedUrl).toContain("doctor_id=1"));
  });

  it("the old single-add and separate range forms are gone", async () => {
    setUpServer();
    renderWithProviders(<LeavePage />);
    await screen.findByRole("button", { name: "Add leave" });

    expect(screen.queryByRole("button", { name: "Add" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Add range" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Remove range" })).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Period")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Date")).not.toBeInTheDocument();
  });

  describe("add mode", () => {
    it("a multi-day range with both edges full fires exactly one bulk request with period BOTH", async () => {
      setUpServer();
      const bodies = captureBulkBodies();

      const user = userEvent.setup();
      renderWithProviders(<LeavePage />);
      await selectFormDoctor(user, "AB");
      await typeDates(user, "2026-07-13", "2026-07-17");
      await user.click(screen.getByRole("button", { name: "Add leave" }));

      await waitFor(() => expect(bodies).toHaveLength(1));
      expect(bodies[0]).toEqual({
        doctor_id: 1,
        start_date: "2026-07-13",
        end_date: "2026-07-17",
        period: "BOTH",
      });
    });

    it("half-day edges fire three bulk requests: PM edge, interior, AM edge", async () => {
      setUpServer();
      const bodies = captureBulkBodies();

      const user = userEvent.setup();
      renderWithProviders(<LeavePage />);
      await selectFormDoctor(user, "AB");
      await typeDates(user, "2026-07-13", "2026-07-17");
      await user.selectOptions(
        screen.getByLabelText("First day", { selector: "#leave-range-first-day" }),
        "PM_ONLY",
      );
      await user.selectOptions(
        screen.getByLabelText("Last day", { selector: "#leave-range-last-day" }),
        "AM_ONLY",
      );
      await user.click(screen.getByRole("button", { name: "Add leave" }));

      await waitFor(() => expect(bodies).toHaveLength(3));
      expect(bodies).toContainEqual({
        doctor_id: 1,
        start_date: "2026-07-13",
        end_date: "2026-07-13",
        period: "PM",
      });
      expect(bodies).toContainEqual({
        doctor_id: 1,
        start_date: "2026-07-14",
        end_date: "2026-07-16",
        period: "BOTH",
      });
      expect(bodies).toContainEqual({
        doctor_id: 1,
        start_date: "2026-07-17",
        end_date: "2026-07-17",
        period: "AM",
      });
    });

    it("a single-day range swaps the edge selects for one Day select; AM only fires one AM bulk request", async () => {
      setUpServer();
      const bodies = captureBulkBodies();

      const user = userEvent.setup();
      renderWithProviders(<LeavePage />);
      await selectFormDoctor(user, "AB");
      await typeDates(user, "2026-07-15", "2026-07-15");

      expect(screen.queryByLabelText("First day")).not.toBeInTheDocument();
      expect(screen.queryByLabelText("Last day")).not.toBeInTheDocument();
      await user.selectOptions(
        screen.getByLabelText("Day", { selector: "#leave-range-single-day" }),
        "AM_ONLY",
      );
      await user.click(screen.getByRole("button", { name: "Add leave" }));

      await waitFor(() => expect(bodies).toHaveLength(1));
      expect(bodies[0]).toEqual({
        doctor_id: 1,
        start_date: "2026-07-15",
        end_date: "2026-07-15",
        period: "AM",
      });
    });

    it("sums created, duplicate and weekend counts across segments in the summary", async () => {
      setUpServer();
      server.use(
        http.post("/api/v1/leave/bulk", async ({ request }) => {
          const body = (await request.json()) as { period: string };
          if (body.period === "PM") {
            return HttpResponse.json({
              created: [makeLeaveEntry({ date: "2026-07-13", period: "PM" })],
              skipped: [],
              superseded_extra_sessions: [],
            });
          }
          if (body.period === "AM") {
            return HttpResponse.json({
              created: [],
              skipped: [{ date: "2026-07-17", period: "AM", reason: "duplicate" }],
              superseded_extra_sessions: [],
            });
          }
          return HttpResponse.json({
            created: [
              makeLeaveEntry({ date: "2026-07-14", period: "AM" }),
              makeLeaveEntry({ date: "2026-07-14", period: "PM" }),
              makeLeaveEntry({ date: "2026-07-15", period: "AM" }),
              makeLeaveEntry({ date: "2026-07-15", period: "PM" }),
            ],
            skipped: [
              { date: "2026-07-16", period: "AM", reason: "duplicate" },
              { date: "2026-07-16", period: "PM", reason: "duplicate" },
            ],
            superseded_extra_sessions: [],
          });
        }),
      );

      const user = userEvent.setup();
      renderWithProviders(<LeavePage />);
      await selectFormDoctor(user, "AB");
      await typeDates(user, "2026-07-13", "2026-07-17");
      await user.selectOptions(
        screen.getByLabelText("First day", { selector: "#leave-range-first-day" }),
        "PM_ONLY",
      );
      await user.selectOptions(
        screen.getByLabelText("Last day", { selector: "#leave-range-last-day" }),
        "AM_ONLY",
      );
      await user.click(screen.getByRole("button", { name: "Add leave" }));

      expect(await screen.findByText("5 entries added, 3 already existed.")).toBeInTheDocument();
    });

    it("reports a failed segment per segment alongside what did succeed", async () => {
      setUpServer();
      server.use(
        http.post("/api/v1/leave/bulk", async ({ request }) => {
          const body = (await request.json()) as { period: string };
          if (body.period === "AM") {
            return HttpResponse.json({ detail: "server error" }, { status: 500 });
          }
          return HttpResponse.json({
            created: [makeLeaveEntry()],
            skipped: [],
            superseded_extra_sessions: [],
          });
        }),
      );

      const user = userEvent.setup();
      renderWithProviders(<LeavePage />);
      await selectFormDoctor(user, "AB");
      await typeDates(user, "2026-07-13", "2026-07-17");
      await user.selectOptions(
        screen.getByLabelText("Last day", { selector: "#leave-range-last-day" }),
        "AM_ONLY",
      );
      await user.click(screen.getByRole("button", { name: "Add leave" }));

      expect(
        await screen.findByText(/2026-07-17 \(AM\): server error\. 1 entries added\./),
      ).toBeInTheDocument();
    });

    it("appends a supersede warning when the bulk-add response reports superseded extra sessions", async () => {
      setUpServer();
      server.use(
        http.post("/api/v1/leave/bulk", () =>
          HttpResponse.json({
            created: [makeLeaveEntry({ date: "2026-07-13", period: "AM" })],
            skipped: [],
            superseded_extra_sessions: [
              { id: 1, doctor_id: 1, date: "2026-07-13", period: "AM" },
            ],
          }),
        ),
      );

      const user = userEvent.setup();
      renderWithProviders(<LeavePage />);
      await selectFormDoctor(user, "AB");
      await typeDates(user, "2026-07-13", "2026-07-13");
      await user.click(screen.getByRole("button", { name: "Add leave" }));

      expect(
        await screen.findByText(
          "1 entries added. Warning: this leave supersedes 1 planned extra session (2026-07-13) - review them on the Extra Sessions page.",
        ),
      ).toBeInTheDocument();
    });

    it("blocks submission with an inline error when the end date is before the start date", async () => {
      setUpServer();
      const bodies = captureBulkBodies();

      const user = userEvent.setup();
      renderWithProviders(<LeavePage />);
      await selectFormDoctor(user, "AB");
      await typeDates(user, "2026-07-17", "2026-07-13");
      await user.click(screen.getByRole("button", { name: "Add leave" }));

      expect(await screen.findByText("End date must not be before start date.")).toBeInTheDocument();
      expect(bodies).toHaveLength(0);
    });

    it("blocks submission with an inline error when the range exceeds 366 days", async () => {
      setUpServer();
      const bodies = captureBulkBodies();

      const user = userEvent.setup();
      renderWithProviders(<LeavePage />);
      await selectFormDoctor(user, "AB");
      await typeDates(user, "2026-01-01", "2027-06-01");
      await user.click(screen.getByRole("button", { name: "Add leave" }));

      expect(await screen.findByText("Range must not exceed 366 days.")).toBeInTheDocument();
      expect(bodies).toHaveLength(0);
    });

    it("changing a date resets the half-day selects to full days", async () => {
      setUpServer();

      const user = userEvent.setup();
      renderWithProviders(<LeavePage />);
      await selectFormDoctor(user, "AB");
      await typeDates(user, "2026-07-13", "2026-07-17");
      await user.selectOptions(
        screen.getByLabelText("First day", { selector: "#leave-range-first-day" }),
        "PM_ONLY",
      );

      const endInput = screen.getByLabelText("End date", { selector: "#leave-range-end" });
      await user.clear(endInput);
      await user.type(endInput, "2026-07-16");

      expect(screen.getByLabelText("First day", { selector: "#leave-range-first-day" })).toHaveValue(
        "FULL",
      );
    });

    it("shows the preview once a doctor and valid dates are set, and not before", async () => {
      setUpServer();

      const user = userEvent.setup();
      renderWithProviders(<LeavePage />);
      await screen.findByRole("button", { name: "Add leave" });
      expect(screen.queryByTestId("leave-range-preview")).not.toBeInTheDocument();

      await selectFormDoctor(user, "AB");
      await typeDates(user, "2026-07-13", "2026-07-17");

      expect(await screen.findByTestId("leave-range-preview")).toBeInTheDocument();
    });
  });

  describe("remove mode", () => {
    it("asks for confirmation, fires bulk-delete per segment and sums deleted counts", async () => {
      setUpServer();
      vi.spyOn(window, "confirm").mockReturnValue(true);
      const bodies: { doctor_id: number; start_date: string; end_date: string; period: string }[] = [];
      server.use(
        http.post("/api/v1/leave/bulk-delete", async ({ request }) => {
          const body = (await request.json()) as (typeof bodies)[number];
          bodies.push(body);
          return HttpResponse.json({ deleted_count: body.period === "BOTH" ? 6 : 1 });
        }),
      );

      const user = userEvent.setup();
      renderWithProviders(<LeavePage />);
      await user.click(await screen.findByRole("radio", { name: "Remove leave" }));
      await selectFormDoctor(user, "AB");
      await typeDates(user, "2026-07-13", "2026-07-17");
      await user.selectOptions(
        screen.getByLabelText("First day", { selector: "#leave-range-first-day" }),
        "PM_ONLY",
      );
      await user.selectOptions(
        screen.getByLabelText("Last day", { selector: "#leave-range-last-day" }),
        "AM_ONLY",
      );
      await user.click(screen.getByRole("button", { name: "Remove leave" }));

      expect(window.confirm).toHaveBeenCalledWith(
        "Remove all leave for AB from 2026-07-13 (PM only) to 2026-07-17 (AM only)? This cannot be undone from here.",
      );
      await waitFor(() => expect(bodies).toHaveLength(3));
      expect(bodies).toContainEqual({
        doctor_id: 1,
        start_date: "2026-07-13",
        end_date: "2026-07-13",
        period: "PM",
      });
      expect(bodies).toContainEqual({
        doctor_id: 1,
        start_date: "2026-07-14",
        end_date: "2026-07-16",
        period: "BOTH",
      });
      expect(bodies).toContainEqual({
        doctor_id: 1,
        start_date: "2026-07-17",
        end_date: "2026-07-17",
        period: "AM",
      });
      expect(await screen.findByText("8 entries removed.")).toBeInTheDocument();

      vi.restoreAllMocks();
    });

    it("does not call bulk-delete if the confirmation is declined", async () => {
      setUpServer();
      vi.spyOn(window, "confirm").mockReturnValue(false);
      let called = false;
      server.use(
        http.post("/api/v1/leave/bulk-delete", async () => {
          called = true;
          return HttpResponse.json({ deleted_count: 4 });
        }),
      );

      const user = userEvent.setup();
      renderWithProviders(<LeavePage />);
      await user.click(await screen.findByRole("radio", { name: "Remove leave" }));
      await selectFormDoctor(user, "AB");
      await typeDates(user, "2026-07-13", "2026-07-17");
      await user.click(screen.getByRole("button", { name: "Remove leave" }));

      expect(window.confirm).toHaveBeenCalled();
      expect(called).toBe(false);

      vi.restoreAllMocks();
    });
  });

  it("delete removes an entry from the table", async () => {
    setUpServer({ leave: [makeLeaveEntry({ id: 1, doctor_id: 1, date: "2026-08-03" })] });
    let deleted = false;
    server.use(
      http.delete("/api/v1/leave/1", () => {
        deleted = true;
        return new HttpResponse(null, { status: 204 });
      }),
      http.get("/api/v1/leave", () =>
        HttpResponse.json(deleted ? [] : [makeLeaveEntry({ id: 1, doctor_id: 1, date: "2026-08-03" })]),
      ),
    );

    const user = userEvent.setup();
    renderWithProviders(<LeavePage />);
    const table = await screen.findByRole("table");
    within(table).getByText("Mon, 2026-08-03");

    await user.click(screen.getByRole("button", { name: "Delete" }));

    expect(deleted).toBe(true);
    expect(await screen.findByText("No leave entries.")).toBeInTheDocument();
  });
});