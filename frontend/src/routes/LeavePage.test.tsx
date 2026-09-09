import { HttpResponse, http } from "msw";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { makeDoctor, makeLeaveEntitlement, makeLeaveEntry } from "@/test/fixtures/reference";
import { renderWithProviders } from "@/test/renderWithProviders";
import { server } from "@/test/msw/server";

import { SessionYearControl, SessionYearProvider } from "@/components/SessionManagementTabs";

import { LeavePage } from "./LeavePage";

/** Outside a SessionYearProvider the page falls back to the current year,
 * which is what most cases here render in. */
const CURRENT_YEAR = new Date().getFullYear();

function setUpServer({
  doctors = [makeDoctor({ id: 1, code: "AB", active: true })],
  leave = [] as ReturnType<typeof makeLeaveEntry>[],
} = {}) {
  server.use(
    http.get("/api/v1/doctors", () => HttpResponse.json(doctors)),
    http.get("/api/v1/leave", () => HttpResponse.json(leave)),
  );
}

/** The page under the shared-year provider, on `year`, the way the Session
 * Management layout mounts it. */
function renderOnYear(year: number) {
  return renderWithProviders(
    <SessionYearProvider>
      <LeavePage />
    </SessionYearProvider>,
    { route: `/?year=${year}` },
  );
}

/** A /leave handler that records every request URL it serves. */
function captureLeaveRequests(leave: ReturnType<typeof makeLeaveEntry>[] = []) {
  const urls: string[] = [];
  server.use(
    http.get("/api/v1/leave", ({ request }) => {
      urls.push(request.url);
      return HttpResponse.json(leave);
    }),
  );
  return urls;
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

/**
 * Stubs the entitlement endpoint and records the `year` each request asked
 * for, so a test can prove the year control actually re-queries rather than
 * just re-rendering the same numbers under a new heading.
 */
function captureEntitlementYears(rows: ReturnType<typeof makeLeaveEntitlement>[]) {
  const years: string[] = [];
  server.use(
    http.get("/api/v1/leave/entitlement", ({ request }) => {
      const year = new URL(request.url).searchParams.get("year") ?? "";
      years.push(year);
      return HttpResponse.json({
        year: Number(year),
        from_date: `${year}-01-01`,
        to_date: `${year}-12-31`,
        doctors: rows,
      });
    }),
  );
  return years;
}

describe("LeavePage", () => {
  it("shows an empty-state message when there are no entries", async () => {
    setUpServer();
    renderWithProviders(<LeavePage />);

    expect(await screen.findByText(`No leave entries in ${CURRENT_YEAR}.`)).toBeInTheDocument();
  });

  it("collapses a doctor's consecutive weekday entries into a single block row", async () => {
    const dates = ["2026-08-03", "2026-08-04", "2026-08-05", "2026-08-06", "2026-08-07"];
    const leave = dates.flatMap((date, i) => [
      makeLeaveEntry({ id: i * 2 + 1, doctor_id: 1, date, period: "AM" }),
      makeLeaveEntry({ id: i * 2 + 2, doctor_id: 1, date, period: "PM" }),
    ]);
    setUpServer({ leave });
    renderWithProviders(<LeavePage />);

    const table = await screen.findByRole("table");
    const rows = within(table).getAllByRole("row");
    // header + one block row
    expect(rows).toHaveLength(2);
    expect(
      within(table).getByText("Mon, 2026-08-03 to Fri, 2026-08-07"),
    ).toBeInTheDocument();
    expect(within(table).getByText("AB")).toBeInTheDocument();
    expect(within(table).getByText("Full day")).toBeInTheDocument();
  });

  it("annotates a block with a PM-only leading edge", async () => {
    setUpServer({
      leave: [
        makeLeaveEntry({ id: 1, doctor_id: 1, date: "2026-08-03", period: "PM" }),
        makeLeaveEntry({ id: 2, doctor_id: 1, date: "2026-08-04", period: "AM" }),
        makeLeaveEntry({ id: 3, doctor_id: 1, date: "2026-08-04", period: "PM" }),
      ],
    });
    renderWithProviders(<LeavePage />);

    const table = await screen.findByRole("table");
    expect(
      within(table).getByText("Mon, 2026-08-03 (PM only) to Tue, 2026-08-04"),
    ).toBeInTheDocument();
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

  describe("block delete", () => {
    const dates = ["2026-08-03", "2026-08-04", "2026-08-05", "2026-08-06", "2026-08-07"];
    function fullDayLeave() {
      return dates.flatMap((date, i) => [
        makeLeaveEntry({ id: i * 2 + 1, doctor_id: 1, date, period: "AM" as const }),
        makeLeaveEntry({ id: i * 2 + 2, doctor_id: 1, date, period: "PM" as const }),
      ]);
    }

    it("deleting a block fires one bulk-delete request spanning the block and empties the table", async () => {
      let deleted = false;
      setUpServer({ leave: fullDayLeave() });
      vi.spyOn(window, "confirm").mockReturnValue(true);
      const bodies: { doctor_id: number; start_date: string; end_date: string; period: string }[] = [];
      server.use(
        http.post("/api/v1/leave/bulk-delete", async ({ request }) => {
          bodies.push((await request.json()) as (typeof bodies)[number]);
          deleted = true;
          return HttpResponse.json({ deleted_count: 10 });
        }),
        http.get("/api/v1/leave", () => HttpResponse.json(deleted ? [] : fullDayLeave())),
      );

      const user = userEvent.setup();
      renderWithProviders(<LeavePage />);
      const table = await screen.findByRole("table");
      within(table).getByText("Mon, 2026-08-03 to Fri, 2026-08-07");

      await user.click(screen.getByRole("button", { name: "Delete" }));

      expect(window.confirm).toHaveBeenCalledWith(
        "Remove all leave for AB from 2026-08-03 to 2026-08-07? This cannot be undone from here.",
      );
      await waitFor(() => expect(bodies).toHaveLength(1));
      expect(bodies[0]).toEqual({
        doctor_id: 1,
        start_date: "2026-08-03",
        end_date: "2026-08-07",
        period: "BOTH",
      });
      expect(await screen.findByText(`No leave entries in ${CURRENT_YEAR}.`)).toBeInTheDocument();

      vi.restoreAllMocks();
    });

    it("declining the confirm fires no request", async () => {
      setUpServer({ leave: fullDayLeave() });
      vi.spyOn(window, "confirm").mockReturnValue(false);
      let called = false;
      server.use(
        http.post("/api/v1/leave/bulk-delete", async () => {
          called = true;
          return HttpResponse.json({ deleted_count: 10 });
        }),
      );

      const user = userEvent.setup();
      renderWithProviders(<LeavePage />);
      await screen.findByRole("table");

      await user.click(screen.getByRole("button", { name: "Delete" }));

      expect(window.confirm).toHaveBeenCalled();
      expect(called).toBe(false);

      vi.restoreAllMocks();
    });
  });

  it("the unfiltered view groups each doctor's blocks together in display order", async () => {
    setUpServer({
      doctors: [
        makeDoctor({ id: 1, code: "ZZ", doctor_type: "Partner", active: true }),
        makeDoctor({ id: 2, code: "AA", doctor_type: "Salaried", active: true }),
      ],
      leave: [
        makeLeaveEntry({ id: 1, doctor_id: 2, date: "2026-08-03", period: "AM" }),
        makeLeaveEntry({ id: 2, doctor_id: 1, date: "2026-08-04", period: "AM" }),
        makeLeaveEntry({ id: 3, doctor_id: 2, date: "2026-08-05", period: "AM" }),
        makeLeaveEntry({ id: 4, doctor_id: 1, date: "2026-08-06", period: "AM" }),
      ],
    });
    renderWithProviders(<LeavePage />);

    const table = await screen.findByRole("table");
    const rows = within(table).getAllByRole("row").slice(1);
    const doctorCodes = rows.map((row) => within(row).getAllByRole("cell")[1].textContent);

    expect(doctorCodes).toEqual(["ZZ", "ZZ", "AA", "AA"]);
  });
  describe("leave entitlement summary", () => {
    /** The two-doctor practice every test in this block filters within. */
    function setUpTwoDoctors() {
      setUpServer({
        doctors: [
          makeDoctor({ id: 1, code: "AB", active: true }),
          makeDoctor({ id: 2, code: "CD", doctor_type: "Partner", active: true }),
        ],
      });
      return captureEntitlementYears([
        makeLeaveEntitlement({
          doctor_id: 1,
          doctor_code: "AB",
          used_sessions: 10,
          entitlement_sessions: "36.0",
          remaining_sessions: "26.0",
        }),
        makeLeaveEntitlement({
          doctor_id: 2,
          doctor_code: "CD",
          doctor_type: "Partner",
          entitlement_sessions: "70.0",
          used_sessions: 4,
          remaining_sessions: "66.0",
        }),
      ]);
    }

    async function filterTo(user: ReturnType<typeof userEvent.setup>, code: string) {
      const filter = await screen.findByLabelText("Doctor", { selector: "#leave-filter" });
      await user.selectOptions(filter, await within(filter).findByRole("option", { name: code }));
    }

    it("shows nothing until a doctor is selected", async () => {
      setUpTwoDoctors();
      renderWithProviders(<LeavePage />);

      expect(await screen.findByText(`No leave entries in ${CURRENT_YEAR}.`)).toBeInTheDocument();
      expect(screen.queryByTestId("leave-entitlement")).not.toBeInTheDocument();
    });

    it("shows only the selected doctor's fraction once one is picked", async () => {
      const user = userEvent.setup();
      setUpTwoDoctors();
      renderWithProviders(<LeavePage />);

      await filterTo(user, "AB");

      expect(await screen.findByTestId("leave-fraction-AB")).toHaveTextContent("10/36");
      expect(screen.queryByTestId("leave-fraction-CD")).not.toBeInTheDocument();
    });

    it("queries the current year by default", async () => {
      setUpServer();
      const years = captureEntitlementYears([]);
      renderWithProviders(<LeavePage />);

      await waitFor(() => expect(years).toEqual([String(new Date().getFullYear())]));
    });

    it("queries the shared year, not the current one", async () => {
      setUpTwoDoctors();
      const years = captureEntitlementYears([]);
      renderOnYear(CURRENT_YEAR + 1);

      await waitFor(() => expect(years).toEqual([String(CURRENT_YEAR + 1)]));
    });

    it("captions the calendar with the shared year the balance is for", async () => {
      const user = userEvent.setup();
      setUpTwoDoctors();
      renderOnYear(CURRENT_YEAR + 1);

      await filterTo(user, "AB");

      const calendar = await screen.findByTestId("leave-year-calendar");
      expect(within(calendar).getByText(String(CURRENT_YEAR + 1))).toBeInTheDocument();
      expect(await screen.findByTestId("leave-entitlement")).toHaveTextContent(
        String(CURRENT_YEAR + 1),
      );
    });

    it("says nothing for a doctor with no entitlement row", async () => {
      const user = userEvent.setup();
      setUpServer({
        doctors: [makeDoctor({ id: 1, code: "AB", doctor_type: "AHP", active: true })],
      });
      captureEntitlementYears([]);
      renderWithProviders(<LeavePage />);

      await filterTo(user, "AB");

      expect(await screen.findByTestId("leave-year-calendar")).toBeInTheDocument();
      expect(screen.queryByTestId("leave-entitlement")).not.toBeInTheDocument();
    });
  });

  describe("the linked doctor default", () => {
    const LINKED_AB = { linked_doctor: { id: 1, code: "AB", active: true } };

    it("opens the filter on the doctor this login is linked to", async () => {
      setUpServer();
      captureEntitlementYears([makeLeaveEntitlement({ doctor_id: 1, doctor_code: "AB" })]);
      renderWithProviders(<LeavePage />, { authUser: LINKED_AB });

      const filter = await screen.findByLabelText("Doctor", { selector: "#leave-filter" });
      await waitFor(() => expect(filter).toHaveValue("1"));
      expect(await screen.findByTestId("leave-year-calendar")).toBeInTheDocument();
    });

    it("opens on All doctors for an unlinked user", async () => {
      setUpServer();
      captureEntitlementYears([makeLeaveEntitlement({ doctor_id: 1, doctor_code: "AB" })]);
      renderWithProviders(<LeavePage />);

      const filter = await screen.findByLabelText("Doctor", { selector: "#leave-filter" });
      expect(filter).toHaveValue("");
      expect(screen.queryByTestId("leave-year-calendar")).not.toBeInTheDocument();
    });

    it("leaves the add/remove form's doctor unselected for a linked user", async () => {
      setUpServer();
      captureEntitlementYears([makeLeaveEntitlement({ doctor_id: 1, doctor_code: "AB" })]);
      renderWithProviders(<LeavePage />, { authUser: LINKED_AB });

      // Deliberate: defaulting a *write* form to yourself is one mis-click
      // from booking leave for the wrong person.
      const form = await screen.findByLabelText("Doctor", { selector: "#leave-range-doctor" });
      expect(form).toHaveValue("");
    });

    it("lets a linked user filter back to All doctors", async () => {
      const user = userEvent.setup();
      setUpServer();
      captureEntitlementYears([makeLeaveEntitlement({ doctor_id: 1, doctor_code: "AB" })]);
      renderWithProviders(<LeavePage />, { authUser: LINKED_AB });

      const filter = await screen.findByLabelText("Doctor", { selector: "#leave-filter" });
      await waitFor(() => expect(filter).toHaveValue("1"));

      await user.selectOptions(filter, within(filter).getByRole("option", { name: "All doctors" }));

      expect(filter).toHaveValue("");
      expect(screen.queryByTestId("leave-year-calendar")).not.toBeInTheDocument();
    });
  });

  describe("the shared session year", () => {
    it("requests only the selected year's entries for the table", async () => {
      setUpServer();
      const urls = captureLeaveRequests();
      renderOnYear(CURRENT_YEAR + 1);

      expect(
        await screen.findByText(`No leave entries in ${CURRENT_YEAR + 1}.`),
      ).toBeInTheDocument();
      const params = new URL(urls[0]).searchParams;
      expect(params.get("from_date")).toBe(`${CURRENT_YEAR + 1}-01-01`);
      expect(params.get("to_date")).toBe(`${CURRENT_YEAR + 1}-12-31`);
    });

    it("leaves the overlap preview's query unfiltered by year", async () => {
      const user = userEvent.setup();
      setUpServer();
      const urls = captureLeaveRequests();
      renderOnYear(CURRENT_YEAR + 1);

      await selectFormDoctor(user, "AB");

      // Two queries for the same doctor: the table's, bounded to the year,
      // and the preview's, which must see a range running past 31 December.
      await waitFor(() => {
        const forDoctor = urls
          .map((url) => new URL(url).searchParams)
          .filter((params) => params.get("doctor_id") === "1");
        expect(forDoctor.some((params) => params.get("from_date") !== null)).toBe(true);
        expect(forDoctor.some((params) => params.get("from_date") === null)).toBe(true);
      });
    });

    it("re-queries the table and the entitlement together when the year changes", async () => {
      const user = userEvent.setup();
      setUpServer();
      const urls = captureLeaveRequests();
      const years = captureEntitlementYears([]);
      renderWithProviders(
        <SessionYearProvider>
          <SessionYearControl />
          <LeavePage />
        </SessionYearProvider>,
        { route: `/?year=${CURRENT_YEAR}` },
      );

      await waitFor(() => expect(years).toEqual([String(CURRENT_YEAR)]));
      await user.click(screen.getByLabelText("Next year"));

      await waitFor(() => expect(years).toContain(String(CURRENT_YEAR + 1)));
      await waitFor(() =>
        expect(
          urls.some(
            (url) =>
              new URL(url).searchParams.get("from_date") === `${CURRENT_YEAR + 1}-01-01`,
          ),
        ).toBe(true),
      );
    });
  });
});
