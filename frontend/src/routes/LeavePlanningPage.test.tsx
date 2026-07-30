import { HttpResponse, http } from "msw";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type {
  BankHoliday,
  CoverageSlot,
  Doctor,
  ExtraSessionEntry,
  LeaveEntry,
  PlanningActionIn,
  PlanningBulkOut,
  School,
} from "@/api/types";
import { makeMasterRotaSession, makeMasterRotaTemplate } from "@/test/fixtures/masterRota";
import {
  makeClosure,
  makeDoctor,
  makeExtraSessionEntry,
  makeLeaveEntry,
  makeSchool,
  makeSchoolHoliday,
} from "@/test/fixtures/reference";
import { renderWithProviders } from "@/test/renderWithProviders";
import { server } from "@/test/msw/server";

import { LeavePlanningPage } from "./LeavePlanningPage";

// The page defaults to the current month, so the clock is pinned rather
// than the tests chasing it. 2026-08-03 is a Monday.
const MONDAY = "2026-08-03";
const TUESDAY = "2026-08-04";

const AA = makeDoctor({ id: 1, code: "AA", doctor_type: "Partner" });
const BB = makeDoctor({ id: 2, code: "BB", doctor_type: "Salaried" });
const TRAINEE = makeDoctor({ id: 3, code: "TT", doctor_type: "Trainee" });
const AHP = makeDoctor({ id: 4, code: "HH", doctor_type: "AHP" });
const LOCUM = makeDoctor({ id: 7, code: "LL", doctor_type: "Locum" });

/** Both partners working requires_room all day Monday, per template week 1. */
const TEMPLATE = makeMasterRotaTemplate({
  sessions: [
    makeMasterRotaSession({ doctor_id: 1, week: 1, day: "Monday", period: "AM" }),
    makeMasterRotaSession({ doctor_id: 1, week: 1, day: "Monday", period: "PM" }),
    makeMasterRotaSession({ doctor_id: 2, week: 1, day: "Monday", period: "AM" }),
    makeMasterRotaSession({ doctor_id: 2, week: 1, day: "Monday", period: "PM" }),
  ],
});

function coverageFor(dates: string[], headcount: number): CoverageSlot[] {
  return dates.flatMap((date) =>
    (["AM", "PM"] as const).map((period) => ({ date, period, headcount, is_closed: false })),
  );
}

function setUpServer({
  doctors = [AA, BB],
  leave = [] as LeaveEntry[],
  extraSessions = [] as ExtraSessionEntry[],
  closures = [] as ReturnType<typeof makeClosure>[],
  coverage = coverageFor([MONDAY, TUESDAY], 2),
  template = TEMPLATE,
  schools = [] as School[],
  bankHolidays,
}: {
  doctors?: Doctor[];
  leave?: LeaveEntry[];
  extraSessions?: ExtraSessionEntry[];
  closures?: ReturnType<typeof makeClosure>[];
  coverage?: CoverageSlot[];
  template?: typeof TEMPLATE;
  schools?: School[];
  bankHolidays?: BankHoliday[];
} = {}) {
  server.use(
    http.get("/api/v1/doctors", () => HttpResponse.json(doctors)),
    http.get("/api/v1/leave", () => HttpResponse.json(leave)),
    http.get("/api/v1/extra-sessions", () => HttpResponse.json(extraSessions)),
    http.get("/api/v1/closures", () => HttpResponse.json(closures)),
    http.get("/api/v1/leave-planning/coverage", () => HttpResponse.json(coverage)),
    http.get("/api/v1/master-rota/active", () => HttpResponse.json(template)),
    http.get("/api/v1/schools", () => HttpResponse.json(schools)),
    ...(bankHolidays
      ? [http.get("/api/v1/closures/bank-holidays", () => HttpResponse.json(bankHolidays))]
      : []),
  );
}

/** A /leave-planning/bulk handler recording the posted batches. */
function captureBulkBodies(
  response: PlanningBulkOut = { applied: 0, skipped: [], superseded_extra_sessions: [] },
) {
  const bodies: { actions: PlanningActionIn[] }[] = [];
  server.use(
    http.post("/api/v1/leave-planning/bulk", async ({ request }) => {
      bodies.push((await request.json()) as (typeof bodies)[number]);
      return HttpResponse.json(response);
    }),
  );
  return bodies;
}

function cell(doctorId: number, date: string, period: "AM" | "PM") {
  return screen.getByTestId(`planning-cell-${doctorId}-${date}-${period}`);
}

async function findCell(doctorId: number, date: string, period: "AM" | "PM") {
  return screen.findByTestId(`planning-cell-${doctorId}-${date}-${period}`);
}

describe("LeavePlanningPage", () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(new Date(2026, 7, 10));
    return () => vi.useRealTimers();
  });

  it("renders Partner, Salaried, and Locum rows only", async () => {
    setUpServer({ doctors: [AA, BB, LOCUM, TRAINEE, AHP] });
    renderWithProviders(<LeavePlanningPage />);

    expect(await screen.findByText("AA")).toBeInTheDocument();
    expect(screen.getByText("BB")).toBeInTheDocument();
    expect(screen.getByText("LL")).toBeInTheDocument();
    expect(screen.queryByText("TT")).not.toBeInTheDocument();
    expect(screen.queryByText("HH")).not.toBeInTheDocument();
  });

  it("shows the current month's weekdays and moves between months", async () => {
    const user = userEvent.setup();
    setUpServer();
    renderWithProviders(<LeavePlanningPage />);

    expect(await screen.findByText("August 2026")).toBeInTheDocument();
    expect(screen.getByTestId(`planning-header-${MONDAY}`)).toBeInTheDocument();
    // 2026-08-01 is a Saturday - the grid is weekdays only.
    expect(screen.queryByTestId("planning-header-2026-08-01")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Next" }));
    expect(await screen.findByText("September 2026")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Previous" }));
    await user.click(screen.getByRole("button", { name: "Previous" }));
    expect(await screen.findByText("July 2026")).toBeInTheDocument();
  });

  it("renders existing leave and extra sessions", async () => {
    setUpServer({
      leave: [makeLeaveEntry({ doctor_id: 1, date: MONDAY, period: "AM" })],
      extraSessions: [makeExtraSessionEntry({ doctor_id: 2, date: TUESDAY, period: "PM" })],
    });
    renderWithProviders(<LeavePlanningPage />);

    expect(await findCell(1, MONDAY, "AM")).toHaveAttribute("data-state", "leave");
    expect(cell(2, TUESDAY, "PM")).toHaveAttribute("data-state", "extra_session");
  });

  it("updates the cover total live as cells are toggled, before any save", async () => {
    const user = userEvent.setup();
    setUpServer();
    renderWithProviders(<LeavePlanningPage />);

    const total = () => screen.getByTestId(`planning-total-${MONDAY}-AM`);
    await waitFor(() => expect(total()).toHaveTextContent("2"));

    // One click: leave for AA, so cover drops to 1.
    await user.click(await findCell(1, MONDAY, "AM"));
    expect(total()).toHaveTextContent("1");

    // Second click: extra planned. AA already worked this slot, so the
    // override is a no-op and cover comes back to 2 - not 3.
    await user.click(cell(1, MONDAY, "AM"));
    expect(total()).toHaveTextContent("2");

    // Third click: back to normal, and the edit stops counting as unsaved.
    await user.click(cell(1, MONDAY, "AM"));
    expect(total()).toHaveTextContent("2");
    expect(screen.queryByTestId("planning-unsaved-count")).not.toBeInTheDocument();
  });

  it("raises the total for an extra session on a slot the doctor does not normally work", async () => {
    const user = userEvent.setup();
    setUpServer({ coverage: coverageFor([MONDAY, TUESDAY], 0) });
    renderWithProviders(<LeavePlanningPage />);

    // Tuesday has no template row at all, so an extra session there is a
    // genuine +1 (the copy loop's new-row branch).
    await user.click(await findCell(1, TUESDAY, "AM"));
    await user.click(cell(1, TUESDAY, "AM"));

    expect(cell(1, TUESDAY, "AM")).toHaveAttribute("data-state", "extra_session");
    expect(screen.getByTestId(`planning-total-${TUESDAY}-AM`)).toHaveTextContent("1");
  });

  it("counts unsaved edits and clears them on Discard", async () => {
    const user = userEvent.setup();
    setUpServer();
    renderWithProviders(<LeavePlanningPage />);

    await user.click(await findCell(1, MONDAY, "AM"));
    await user.click(cell(2, MONDAY, "PM"));
    expect(screen.getByTestId("planning-unsaved-count")).toHaveTextContent("2 unsaved changes");

    await user.click(screen.getByRole("button", { name: "Discard" }));
    expect(screen.queryByTestId("planning-unsaved-count")).not.toBeInTheDocument();
    expect(cell(1, MONDAY, "AM")).toHaveAttribute("data-state", "normal");
  });

  it("disables Save and Discard with nothing pending", async () => {
    setUpServer();
    renderWithProviders(<LeavePlanningPage />);

    await findCell(1, MONDAY, "AM");
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Discard" })).toBeDisabled();
  });

  it("posts exactly the pending actions and clears the map", async () => {
    const user = userEvent.setup();
    setUpServer();
    const bodies = captureBulkBodies();
    renderWithProviders(<LeavePlanningPage />);

    await user.click(await findCell(1, MONDAY, "AM"));
    await user.click(cell(2, TUESDAY, "PM"));
    await user.click(cell(2, TUESDAY, "PM"));
    await user.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(bodies).toHaveLength(1));
    expect(bodies[0].actions).toEqual([
      { doctor_id: 1, date: MONDAY, period: "AM", action: "leave" },
      { doctor_id: 2, date: TUESDAY, period: "PM", action: "extra_session" },
    ]);
    await waitFor(() =>
      expect(screen.queryByTestId("planning-unsaved-count")).not.toBeInTheDocument(),
    );
  });

  it("clears an existing row before writing the other kind onto the same cell", async () => {
    const user = userEvent.setup();
    setUpServer({ leave: [makeLeaveEntry({ doctor_id: 1, date: MONDAY, period: "AM" })] });
    const bodies = captureBulkBodies();
    renderWithProviders(<LeavePlanningPage />);

    // Existing leave -> extra planned. Without the paired clear the
    // server would skip this as "leave_exists".
    await user.click(await findCell(1, MONDAY, "AM"));
    await user.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(bodies).toHaveLength(1));
    expect(bodies[0].actions).toEqual([
      { doctor_id: 1, date: MONDAY, period: "AM", action: "clear" },
      { doctor_id: 1, date: MONDAY, period: "AM", action: "extra_session" },
    ]);
  });

  it("reports skips and superseded extra sessions as information, not error", async () => {
    const user = userEvent.setup();
    setUpServer();
    captureBulkBodies({
      applied: 1,
      skipped: [
        { doctor_id: 2, date: TUESDAY, period: "AM", action: "leave", reason: "outside_doctor_dates" },
        { doctor_id: 2, date: TUESDAY, period: "PM", action: "leave", reason: "duplicate" },
      ],
      superseded_extra_sessions: [makeExtraSessionEntry({ doctor_id: 1, date: MONDAY, period: "PM" })],
    });
    renderWithProviders(<LeavePlanningPage />);

    await user.click(await findCell(1, MONDAY, "AM"));
    await user.click(screen.getByRole("button", { name: "Save" }));

    const summary = await screen.findByText(/1 change saved/);
    expect(summary).toHaveTextContent("1 already matched");
    expect(summary).toHaveTextContent("1 skipped (doctor not employed on that date)");
    expect(summary).toHaveTextContent(`1 existing extra session (${MONDAY})`);
    // Not styled as an error - the save succeeded.
    expect(summary.className).not.toContain("text-red-700");
  });

  it("keeps the pending edits when the save fails", async () => {
    const user = userEvent.setup();
    setUpServer();
    server.use(
      http.post("/api/v1/leave-planning/bulk", () =>
        HttpResponse.json({ detail: "A leave entry was created concurrently" }, { status: 409 }),
      ),
    );
    renderWithProviders(<LeavePlanningPage />);

    await user.click(await findCell(1, MONDAY, "AM"));
    await user.click(screen.getByRole("button", { name: "Save" }));

    expect(
      await screen.findByText("A leave entry was created concurrently"),
    ).toBeInTheDocument();
    // One transaction: nothing was written, so nothing is dropped here.
    expect(screen.getByTestId("planning-unsaved-count")).toHaveTextContent("1 unsaved change");
    expect(cell(1, MONDAY, "AM")).toHaveAttribute("data-state", "leave");
  });

  it("renders a closed slot inert and its total as an em dash", async () => {
    const user = userEvent.setup();
    setUpServer({
      closures: [makeClosure({ date: MONDAY, period: "AM", name: "Bank holiday" })],
      coverage: [
        { date: MONDAY, period: "AM", headcount: 0, is_closed: true },
        { date: MONDAY, period: "PM", headcount: 2, is_closed: false },
      ],
    });
    renderWithProviders(<LeavePlanningPage />);

    const closed = await findCell(1, MONDAY, "AM");
    expect(closed).toHaveAttribute("data-state", "closed");
    await user.click(closed);
    expect(screen.queryByTestId("planning-unsaved-count")).not.toBeInTheDocument();

    expect(screen.getByTestId(`planning-total-${MONDAY}-AM`)).toHaveTextContent("—");
    expect(screen.getByTestId(`planning-total-${MONDAY}-PM`)).toHaveTextContent("2");
  });

  it("keeps a doctor whose window covers only part of the month, and blanks the rest", async () => {
    const leaver = makeDoctor({ id: 5, code: "LV", doctor_type: "Partner", end_date: MONDAY });
    setUpServer({ doctors: [AA, leaver] });
    renderWithProviders(<LeavePlanningPage />);

    expect(await findCell(5, MONDAY, "AM")).toHaveAttribute("data-state", "normal");
    expect(cell(5, TUESDAY, "AM")).toHaveAttribute("data-state", "out_of_window");
  });

  it("drops a doctor whose window does not overlap the month at all", async () => {
    const gone = makeDoctor({ id: 6, code: "GO", doctor_type: "Partner", end_date: "2026-07-31" });
    setUpServer({ doctors: [AA, gone] });
    renderWithProviders(<LeavePlanningPage />);

    expect(await screen.findByText("AA")).toBeInTheDocument();
    expect(screen.queryByText("GO")).not.toBeInTheDocument();
  });

  it("shows a row for a school with a holiday in August, none for one without", async () => {
    const inView = makeSchool({
      name: "St Mary's",
      holidays: [makeSchoolHoliday({ start_date: "2026-07-21", end_date: "2026-08-31" })],
    });
    const outOfView = makeSchool({
      name: "Other School",
      holidays: [makeSchoolHoliday({ start_date: "2026-01-01", end_date: "2026-01-05" })],
    });
    setUpServer({ schools: [inView, outOfView] });
    renderWithProviders(<LeavePlanningPage />);

    await findCell(1, MONDAY, "AM");
    expect(screen.getByText("St Mary's")).toBeInTheDocument();
    expect(screen.queryByText("Other School")).not.toBeInTheDocument();
  });

  it("shades exactly the weekday columns a holiday covers, spanning a weekend", async () => {
    // 2026-08-07 is a Friday, 2026-08-10 the following Monday - the grid
    // has no weekend columns, so a Fri-Mon holiday shades only those two.
    const FRIDAY = "2026-08-07";
    const NEXT_MONDAY = "2026-08-10";
    const school = makeSchool({
      name: "Weekend School",
      holidays: [makeSchoolHoliday({ start_date: FRIDAY, end_date: NEXT_MONDAY })],
    });
    setUpServer({ schools: [school] });
    renderWithProviders(<LeavePlanningPage />);

    const row = await screen.findByText("Weekend School");
    expect(row).toBeInTheDocument();
    expect(screen.getByTestId(`planning-school-cell-${school.id}-${FRIDAY}`)).toHaveAttribute(
      "data-state",
      "school_holiday",
    );
    expect(screen.getByTestId(`planning-school-cell-${school.id}-${NEXT_MONDAY}`)).toHaveAttribute(
      "data-state",
      "school_holiday",
    );
    expect(screen.getByTestId(`planning-school-cell-${school.id}-${TUESDAY}`)).toHaveAttribute(
      "data-state",
      "normal",
    );
  });

  it("renders a school row as inert cells with no button", async () => {
    const school = makeSchool({
      name: "Inert School",
      holidays: [makeSchoolHoliday({ start_date: MONDAY, end_date: MONDAY })],
    });
    setUpServer({ schools: [school] });
    renderWithProviders(<LeavePlanningPage />);

    const cell = await screen.findByTestId(`planning-school-cell-${school.id}-${MONDAY}`);
    expect(cell.querySelector("button")).not.toBeInTheDocument();
  });

  it("leaves coverage totals and closed-slot rendering unchanged with school rows present", async () => {
    const school = makeSchool({
      name: "Coexisting School",
      holidays: [makeSchoolHoliday({ start_date: MONDAY, end_date: MONDAY })],
    });
    setUpServer({
      schools: [school],
      closures: [makeClosure({ date: MONDAY, period: "AM", name: "Bank holiday" })],
      coverage: [
        { date: MONDAY, period: "AM", headcount: 0, is_closed: true },
        { date: MONDAY, period: "PM", headcount: 2, is_closed: false },
      ],
    });
    renderWithProviders(<LeavePlanningPage />);

    await screen.findByText("Coexisting School");
    expect(screen.getByTestId(`planning-total-${MONDAY}-AM`)).toHaveTextContent("—");
    expect(screen.getByTestId(`planning-total-${MONDAY}-PM`)).toHaveTextContent("2");
    expect(cell(1, MONDAY, "AM")).toHaveAttribute("data-state", "closed");
  });

  it("warns when no bank holiday has a date set for the viewed year", async () => {
    setUpServer({
      bankHolidays: [
        { key: "new_year", name: "New Year's Day", date: null },
        { key: "christmas_day", name: "Christmas Day bank holiday", date: null },
      ],
    });
    renderWithProviders(<LeavePlanningPage />);

    expect(
      await screen.findByTestId("bank-holidays-missing-warning"),
    ).toHaveTextContent("2 of 2 bank holidays for 2026 have not been added yet");
  });

  it("still warns while only some bank holidays are set for the year", async () => {
    setUpServer({
      bankHolidays: [
        { key: "new_year", name: "New Year's Day", date: "2026-01-01" },
        { key: "good_friday", name: "Good Friday", date: null },
        { key: "christmas_day", name: "Christmas Day bank holiday", date: null },
      ],
    });
    renderWithProviders(<LeavePlanningPage />);

    expect(
      await screen.findByTestId("bank-holidays-missing-warning"),
    ).toHaveTextContent("2 of 3 bank holidays for 2026 have not been added yet");
  });

  it("does not warn once every bank holiday is set for the year", async () => {
    setUpServer({
      bankHolidays: [
        { key: "new_year", name: "New Year's Day", date: "2026-01-01" },
        { key: "christmas_day", name: "Christmas Day bank holiday", date: "2026-12-25" },
      ],
    });
    renderWithProviders(<LeavePlanningPage />);

    await findCell(1, MONDAY, "AM");
    expect(screen.queryByTestId("bank-holidays-missing-warning")).not.toBeInTheDocument();
  });

  it("says extra sessions apply at the next staging creation", async () => {
    setUpServer();
    renderWithProviders(<LeavePlanningPage />);

    expect(
      await screen.findByText(/applied when a staging run is next created/),
    ).toBeInTheDocument();
  });
});
