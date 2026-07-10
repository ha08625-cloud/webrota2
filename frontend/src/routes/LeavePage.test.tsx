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
 * The add-row doctor select starts with only "Select..." until the
 * /doctors fetch resolves - selecting an option before then fails with
 * "Value not found in options". Every test that interacts with this
 * select waits for its target option to actually be there first,
 * mirroring the `within(select).findByRole("option", ...)` pattern
 * ClinicTypeFormDialog_test.tsx already established for the same race.
 */
async function selectAddRowDoctor(user: ReturnType<typeof userEvent.setup>, code: string) {
  const select = await screen.findByLabelText("Doctor", { selector: "#leave-add-doctor" });
  const option = await within(select).findByRole("option", { name: code });
  await user.selectOptions(select, option);
  return select;
}

async function selectRangeAddDoctor(user: ReturnType<typeof userEvent.setup>, code: string) {
  const select = await screen.findByLabelText("Doctor", { selector: "#leave-range-add-doctor" });
  const option = await within(select).findByRole("option", { name: code });
  await user.selectOptions(select, option);
  return select;
}

async function selectRangeDeleteDoctor(user: ReturnType<typeof userEvent.setup>, code: string) {
  const select = await screen.findByLabelText("Doctor", { selector: "#leave-range-delete-doctor" });
  const option = await within(select).findByRole("option", { name: code });
  await user.selectOptions(select, option);
  return select;
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
    expect(within(table).getByText("2026-08-03")).toBeInTheDocument();
    expect(within(table).getByText("AB")).toBeInTheDocument();
  });

  it("the doctor filter select includes inactive doctors", async () => {
    setUpServer({ doctors: [makeDoctor({ id: 2, code: "ZZ", active: false })] });
    renderWithProviders(<LeavePage />);

    const filter = await screen.findByLabelText("Doctor", { selector: "#leave-filter" });
    expect(await within(filter).findByRole("option", { name: "ZZ (inactive)" })).toBeInTheDocument();
  });

  it("the add-row doctor select excludes inactive doctors", async () => {
    setUpServer({
      doctors: [makeDoctor({ id: 1, code: "AB", active: true }), makeDoctor({ id: 2, code: "ZZ", active: false })],
    });
    renderWithProviders(<LeavePage />);

    const addSelect = await screen.findByLabelText("Doctor", { selector: "#leave-add-doctor" });
    expect(await within(addSelect).findByRole("option", { name: "AB" })).toBeInTheDocument();
    expect(within(addSelect).queryByRole("option", { name: /ZZ/ })).not.toBeInTheDocument();
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

  it("the add-row select groups doctors alphabetically within each type", async () => {
    setUpServer({
      doctors: [
        makeDoctor({ id: 1, code: "LFM", doctor_type: "Partner", active: true }),
        makeDoctor({ id: 2, code: "CL", doctor_type: "Partner", active: true }),
        makeDoctor({ id: 3, code: "DT", doctor_type: "Partner", active: true }),
      ],
    });
    renderWithProviders(<LeavePage />);

    const addSelect = (await screen.findByLabelText("Doctor", {
      selector: "#leave-add-doctor",
    })) as HTMLSelectElement;
    await within(addSelect).findByRole("option", { name: "CL" });

    const group = addSelect.querySelector("optgroup");
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

  it("both-periods add-row posts two entries, one AM and one PM, for the selected doctor and date", async () => {
    setUpServer();
    const postedBodies: unknown[] = [];
    server.use(
      http.post("/api/v1/leave", async ({ request }) => {
        const body = await request.json();
        postedBodies.push(body);
        return HttpResponse.json(makeLeaveEntry(), { status: 201 });
      }),
    );

    const user = userEvent.setup();
    renderWithProviders(<LeavePage />);
    await selectAddRowDoctor(user, "AB");
    await user.type(screen.getByLabelText("Date", { selector: "#leave-add-date" }), "2026-08-03");
    await user.selectOptions(screen.getByLabelText("Period", { selector: "#leave-add-period" }), "BOTH");
    await user.click(screen.getByRole("button", { name: "Add" }));

    await waitFor(() => expect(postedBodies).toHaveLength(2));
    expect(postedBodies).toContainEqual({ doctor_id: 1, date: "2026-08-03", period: "AM" });
    expect(postedBodies).toContainEqual({ doctor_id: 1, date: "2026-08-03", period: "PM" });
  });

  it("a single-period add-row posts exactly one entry", async () => {
    setUpServer();
    const postedBodies: unknown[] = [];
    server.use(
      http.post("/api/v1/leave", async ({ request }) => {
        postedBodies.push(await request.json());
        return HttpResponse.json(makeLeaveEntry(), { status: 201 });
      }),
    );

    const user = userEvent.setup();
    renderWithProviders(<LeavePage />);
    await selectAddRowDoctor(user, "AB");
    await user.type(screen.getByLabelText("Date", { selector: "#leave-add-date" }), "2026-08-03");
    await user.click(screen.getByRole("button", { name: "Add" }));

    await waitFor(() => expect(postedBodies).toHaveLength(1));
    expect(postedBodies[0]).toEqual({ doctor_id: 1, date: "2026-08-03", period: "AM" });
  });

  it("a partial failure in the both-periods case reports which period failed, not a generic error", async () => {
    setUpServer();
    server.use(
      http.post("/api/v1/leave", async ({ request }) => {
        const body = (await request.json()) as { period: string };
        if (body.period === "PM") {
          return HttpResponse.json(
            { detail: "Leave entry already exists for this doctor/date/period" },
            { status: 409 },
          );
        }
        return HttpResponse.json(makeLeaveEntry(), { status: 201 });
      }),
    );

    const user = userEvent.setup();
    renderWithProviders(<LeavePage />);
    await selectAddRowDoctor(user, "AB");
    await user.type(screen.getByLabelText("Date", { selector: "#leave-add-date" }), "2026-08-03");
    await user.selectOptions(screen.getByLabelText("Period", { selector: "#leave-add-period" }), "BOTH");
    await user.click(screen.getByRole("button", { name: "Add" }));

    expect(await screen.findByText(/PM:.*already exists/)).toBeInTheDocument();
  });

  it("delete removes an entry", async () => {
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
    within(table).getByText("2026-08-03");

    await user.click(screen.getByRole("button", { name: "Delete" }));

    expect(deleted).toBe(true);
    expect(await screen.findByText("No leave entries.")).toBeInTheDocument();
  });

  describe("add a range", () => {
    it("submits the range and shows a summary of created/duplicate/weekend counts", async () => {
      setUpServer();
      server.use(
        http.post("/api/v1/leave/bulk", async () =>
          HttpResponse.json({
            created: [
              makeLeaveEntry({ id: 1, doctor_id: 1, date: "2026-07-13", period: "AM" }),
              makeLeaveEntry({ id: 2, doctor_id: 1, date: "2026-07-14", period: "AM" }),
            ],
            skipped: [
              { date: "2026-07-11", period: "AM", reason: "weekend" },
              { date: "2026-07-15", period: "AM", reason: "duplicate" },
            ],
          }),
        ),
      );

      const user = userEvent.setup();
      renderWithProviders(<LeavePage />);
      await selectRangeAddDoctor(user, "AB");
      await user.type(screen.getByLabelText("Start date", { selector: "#leave-range-add-start" }), "2026-07-13");
      await user.type(screen.getByLabelText("End date", { selector: "#leave-range-add-end" }), "2026-07-17");
      await user.click(screen.getByRole("button", { name: "Add range" }));

      expect(await screen.findByText(/2 entries added/)).toBeInTheDocument();
      expect(screen.getByText(/1 already existed/)).toBeInTheDocument();
      expect(screen.getByText(/1 weekend slots skipped/)).toBeInTheDocument();
    });

    it("sends the doctor, dates and period in the request body", async () => {
      setUpServer();
      let capturedBody: unknown;
      server.use(
        http.post("/api/v1/leave/bulk", async ({ request }) => {
          capturedBody = await request.json();
          return HttpResponse.json({ created: [], skipped: [] });
        }),
      );

      const user = userEvent.setup();
      renderWithProviders(<LeavePage />);
      await selectRangeAddDoctor(user, "AB");
      await user.type(screen.getByLabelText("Start date", { selector: "#leave-range-add-start" }), "2026-07-13");
      await user.type(screen.getByLabelText("End date", { selector: "#leave-range-add-end" }), "2026-07-17");
      await user.selectOptions(screen.getByLabelText("Period", { selector: "#leave-range-add-period" }), "BOTH");
      await user.click(screen.getByRole("button", { name: "Add range" }));

      await waitFor(() =>
        expect(capturedBody).toEqual({
          doctor_id: 1,
          start_date: "2026-07-13",
          end_date: "2026-07-17",
          period: "BOTH",
        }),
      );
    });

    it("shows the server error detail on failure", async () => {
      setUpServer();
      server.use(
        http.post("/api/v1/leave/bulk", async () =>
          HttpResponse.json({ detail: "range must not exceed 366 days" }, { status: 422 }),
        ),
      );

      const user = userEvent.setup();
      renderWithProviders(<LeavePage />);
      await selectRangeAddDoctor(user, "AB");
      await user.type(screen.getByLabelText("Start date", { selector: "#leave-range-add-start" }), "2026-07-13");
      await user.type(screen.getByLabelText("End date", { selector: "#leave-range-add-end" }), "2026-07-17");
      await user.click(screen.getByRole("button", { name: "Add range" }));

      expect(await screen.findByText("range must not exceed 366 days")).toBeInTheDocument();
    });
  });

  describe("remove a range", () => {
    it("asks for confirmation before calling bulk-delete, and shows a summary on confirm", async () => {
      setUpServer();
      vi.spyOn(window, "confirm").mockReturnValue(true);
      let called = false;
      server.use(
        http.post("/api/v1/leave/bulk-delete", async () => {
          called = true;
          return HttpResponse.json({ deleted_count: 4 });
        }),
      );

      const user = userEvent.setup();
      renderWithProviders(<LeavePage />);
      await selectRangeDeleteDoctor(user, "AB");
      await user.type(screen.getByLabelText("Start date", { selector: "#leave-range-delete-start" }), "2026-07-13");
      await user.type(screen.getByLabelText("End date", { selector: "#leave-range-delete-end" }), "2026-07-17");
      await user.click(screen.getByRole("button", { name: "Remove range" }));

      expect(window.confirm).toHaveBeenCalled();
      expect(called).toBe(true);
      expect(await screen.findByText("4 entries removed.")).toBeInTheDocument();

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
      await selectRangeDeleteDoctor(user, "AB");
      await user.type(screen.getByLabelText("Start date", { selector: "#leave-range-delete-start" }), "2026-07-13");
      await user.type(screen.getByLabelText("End date", { selector: "#leave-range-delete-end" }), "2026-07-17");
      await user.click(screen.getByRole("button", { name: "Remove range" }));

      expect(window.confirm).toHaveBeenCalled();
      expect(called).toBe(false);

      vi.restoreAllMocks();
    });
  });
});