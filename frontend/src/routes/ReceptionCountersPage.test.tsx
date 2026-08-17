import { HttpResponse, http } from "msw";
import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";

import type { ReceptionCounterRow, ReceptionCounters } from "@/api/types";
import { makeReceptionMasterSession } from "@/test/fixtures/reception";
import { renderWithProviders } from "@/test/renderWithProviders";
import { server } from "@/test/msw/server";

import { ReceptionCountersPage } from "./ReceptionCountersPage";

function makeRow(overrides: Partial<ReceptionCounterRow> = {}): ReceptionCounterRow {
  return {
    staff_id: 1,
    staff_code: "JS",
    staff_name: "Jo Smith",
    active: true,
    hours_worked: 0,
    days_present: 0,
    role_slots: {},
    ...overrides,
  };
}

function makeCounters(overrides: Partial<ReceptionCounters> = {}): ReceptionCounters {
  return {
    from_date: "2026-07-20",
    to_date: "2026-08-17",
    days_counted: 18,
    staff: [],
    ...overrides,
  };
}

function mockCounters(counters: ReceptionCounters) {
  server.use(http.get("/api/v1/reception/counters", () => HttpResponse.json(counters)));
}

function mockMaster(sessions: unknown[] = []) {
  server.use(http.get("/api/v1/reception/master", () => HttpResponse.json(sessions)));
}

/** The row cells for one staff member, by their name cell's row. */
function rowFor(name: string) {
  return screen.getByText(name).closest("tr") as HTMLElement;
}

describe("ReceptionCountersPage", () => {
  it("renders a row per staff member with hours worked, days present and slot counts", async () => {
    mockCounters(
      makeCounters({
        staff: [
          makeRow({
            staff_id: 1,
            staff_name: "Jo Smith",
            hours_worked: 10,
            days_present: 4,
            role_slots: { phones: 12, admin: 8, not_working: 3 },
          }),
          makeRow({ staff_id: 2, staff_name: "Alex Lee", hours_worked: 2.5, days_present: 1 }),
        ],
      }),
    );
    mockMaster([
      makeReceptionMasterSession({ staff_id: 1, role: "phones" }),
      makeReceptionMasterSession({ staff_id: 1, role: "phones" }),
      makeReceptionMasterSession({ staff_id: 1, role: "not_working" }),
    ]);

    renderWithProviders(<ReceptionCountersPage />);

    expect(await screen.findByText("Jo Smith")).toBeInTheDocument();

    const jo = within(rowFor("Jo Smith"));
    // Template-derived weekly hours: 2 counted slots -> 1h, not_working excluded.
    expect(jo.getByText("1")).toBeInTheDocument();
    expect(jo.getByText("10")).toBeInTheDocument();
    expect(jo.getByText("4")).toBeInTheDocument();
    expect(jo.getByText("12")).toBeInTheDocument();
    expect(jo.getByText("8")).toBeInTheDocument();

    const alex = within(rowFor("Alex Lee"));
    expect(alex.getByText("2.5")).toBeInTheDocument();
  });

  it("switches the role cells to percentages of hours worked when the toggle is used", async () => {
    mockCounters(
      makeCounters({
        staff: [
          makeRow({
            staff_name: "Jo Smith",
            hours_worked: 10,
            role_slots: { phones: 12, admin: 8 },
          }),
        ],
      }),
    );
    mockMaster();

    renderWithProviders(<ReceptionCountersPage />);
    expect(await screen.findByText("12")).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "% of time" }));

    // 12 slots = 6.0h of 10h worked; 8 slots = 4.0h.
    const jo = within(rowFor("Jo Smith"));
    expect(jo.getByText("60%")).toBeInTheDocument();
    expect(jo.getByText("40%")).toBeInTheDocument();
    expect(jo.queryByText("12")).not.toBeInTheDocument();
  });

  it("renders an em dash for not_working in percentage mode, whose hours are outside the denominator", async () => {
    mockCounters(
      makeCounters({
        staff: [
          makeRow({
            staff_name: "Jo Smith",
            hours_worked: 1,
            role_slots: { phones: 2, not_working: 10 },
          }),
        ],
      }),
    );
    mockMaster();

    renderWithProviders(<ReceptionCountersPage />);
    // Slots mode shows the raw not_working count - it is a real fact.
    expect(await screen.findByText("10")).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "% of time" }));

    const jo = within(rowFor("Jo Smith"));
    // Would otherwise read as 500%, since not_working is excluded from hours worked.
    expect(jo.queryByText("500%")).not.toBeInTheDocument();
    expect(jo.getAllByText("—").length).toBeGreaterThan(0);
    expect(jo.getByText("100%")).toBeInTheDocument();
  });

  it("shows the window bounds and the number of generated days", async () => {
    mockCounters(makeCounters({ days_counted: 6, staff: [] }));
    mockMaster();

    renderWithProviders(<ReceptionCountersPage />);

    expect(await screen.findByText(/6 days generated/)).toBeInTheDocument();
  });

  it("labels an inactive staff member with history rather than hiding the row", async () => {
    mockCounters(
      makeCounters({
        staff: [makeRow({ staff_name: "Sam Old", active: false, hours_worked: 3, days_present: 2 })],
      }),
    );
    mockMaster();

    renderWithProviders(<ReceptionCountersPage />);

    expect(await screen.findByText("Sam Old")).toBeInTheDocument();
    expect(screen.getByText("(inactive)")).toBeInTheDocument();
  });

  it("shows an error message when the counters request fails", async () => {
    server.use(http.get("/api/v1/reception/counters", () => new HttpResponse(null, { status: 500 })));
    mockMaster();

    renderWithProviders(<ReceptionCountersPage />);

    expect(await screen.findByText("Could not load counters.")).toBeInTheDocument();
  });

  it("shows a loading message before the queries resolve", () => {
    mockCounters(makeCounters());
    mockMaster();

    renderWithProviders(<ReceptionCountersPage />);

    expect(screen.getByText("Loading...")).toBeInTheDocument();
  });
});
