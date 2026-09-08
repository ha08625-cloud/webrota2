import { HttpResponse, http } from "msw";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Link } from "react-router-dom";

import type {
  BankHoliday,
  BlockedEntry,
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
  makeLeaveEntitlement,
  makeLeaveEntry,
  makeSchool,
  makeSchoolHoliday,
} from "@/test/fixtures/reference";
import { weekdayName } from "@/lib/planningMonth";
import { renderWithProviders } from "@/test/renderWithProviders";
import { server } from "@/test/msw/server";

import { LeavePlanningPage } from "./LeavePlanningPage";

// The page defaults to the current month, so the clock is pinned rather
// than the tests chasing it. 2026-08-03 is a Monday.
const MONDAY = "2026-08-03";
const TUESDAY = "2026-08-04";
const WEDNESDAY = "2026-08-05";
const THURSDAY = "2026-08-06";
const FRIDAY = "2026-08-07";
const WEEK = [MONDAY, TUESDAY, WEDNESDAY, THURSDAY, FRIDAY];

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
  blocked = [] as BlockedEntry[],
  closures = [] as ReturnType<typeof makeClosure>[],
  coverage = coverageFor([MONDAY, TUESDAY], 2),
  template = TEMPLATE,
  schools = [] as School[],
  bankHolidays,
}: {
  doctors?: Doctor[];
  leave?: LeaveEntry[];
  extraSessions?: ExtraSessionEntry[];
  blocked?: BlockedEntry[];
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
    http.get("/api/v1/leave-planning/blocked", () => HttpResponse.json(blocked)),
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

/** Entitlement rows for the balance line, recording the years asked for so
 * a test can prove the month stepper re-queries across a year boundary. */
function stubEntitlement(rows: ReturnType<typeof makeLeaveEntitlement>[]) {
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

async function findCell(doctorId: number, date: string, period: "AM" | "PM") {
  return screen.findByTestId(`planning-cell-${doctorId}-${date}-${period}`);
}

/** Opens a cell's popover, picks a status from the dropdown, then clicks
 * Apply - the only way to change a cell's state now that clicking opens
 * `PlanningCellPopover` instead of cycling through states directly. */
async function pickCellState(
  user: ReturnType<typeof userEvent.setup>,
  target: HTMLElement,
  state: "normal" | "leave" | "extra_session" | "blocked",
) {
  await user.click(target);
  const popover = screen.getByTestId("planning-cell-popover");
  await user.selectOptions(within(popover).getByTestId("planning-cell-state-select"), state);
  await user.click(within(popover).getByTestId("planning-cell-apply"));
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

  it("adds trainee rows when the toggle is on, and drops them again when it is off", async () => {
    const user = userEvent.setup();
    setUpServer({ doctors: [AA, BB, LOCUM, TRAINEE, AHP] });
    renderWithProviders(<LeavePlanningPage />);

    await screen.findByText("AA");
    await user.click(screen.getByTestId("planning-show-trainees"));

    expect(await screen.findByText("TT")).toBeInTheDocument();
    // Still only trainees - AHPs have no clinical rota row here either way.
    expect(screen.queryByText("HH")).not.toBeInTheDocument();

    await user.click(screen.getByTestId("planning-show-trainees"));
    expect(screen.queryByText("TT")).not.toBeInTheDocument();
  });

  it("leaves the cover total alone for a trainee edit", async () => {
    const user = userEvent.setup();
    // The trainee works Monday in the template, but the coverage endpoint
    // does not count trainees, so its baseline of 2 is the two partners.
    // Taking the trainee off must not move it - the pending recompute is a
    // delta against that baseline, and the trainee was never in it.
    setUpServer({
      doctors: [AA, BB, TRAINEE],
      template: makeMasterRotaTemplate({
        sessions: [
          ...TEMPLATE.sessions,
          makeMasterRotaSession({ doctor_id: 3, week: 1, day: "Monday", period: "AM" }),
        ],
      }),
    });
    renderWithProviders(<LeavePlanningPage />);

    await user.click(await screen.findByTestId("planning-show-trainees"));

    const total = () => screen.getByTestId(`planning-total-${MONDAY}-AM`);
    await waitFor(() => expect(total()).toHaveTextContent("2"));

    await pickCellState(user, await findCell(3, MONDAY, "AM"), "leave");
    expect(await findCell(3, MONDAY, "AM")).toHaveAttribute("data-state", "leave");
    expect(total()).toHaveTextContent("2");

    // A partner's leave still moves it, so the assertion above is not
    // just a dead total row.
    await pickCellState(user, await findCell(1, MONDAY, "AM"), "leave");
    expect(total()).toHaveTextContent("1");
  });

  it("saves a trainee edit like any other", async () => {
    const user = userEvent.setup();
    setUpServer({ doctors: [AA, BB, TRAINEE] });
    const bodies = captureBulkBodies();
    renderWithProviders(<LeavePlanningPage />);

    await user.click(await screen.findByTestId("planning-show-trainees"));
    await pickCellState(user, await findCell(3, MONDAY, "AM"), "leave");
    await user.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(bodies).toHaveLength(1));
    expect(bodies[0].actions).toEqual([
      { doctor_id: 3, date: MONDAY, period: "AM", action: "leave", notes: null },
    ]);
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

  it("renders existing blocked entries, with their note in place of the AM/PM label", async () => {
    setUpServer({
      blocked: [{ id: 1, doctor_id: 1, date: MONDAY, period: "AM", notes: "Training" }],
    });
    renderWithProviders(<LeavePlanningPage />);

    const target = await findCell(1, MONDAY, "AM");
    expect(target).toHaveAttribute("data-state", "blocked");
    expect(target).toHaveTextContent("Training");
  });

  it("drops the total for pending blocked, the same as leave", async () => {
    const user = userEvent.setup();
    setUpServer();
    renderWithProviders(<LeavePlanningPage />);

    const total = () => screen.getByTestId(`planning-total-${MONDAY}-AM`);
    await waitFor(() => expect(total()).toHaveTextContent("2"));

    await pickCellState(user, await findCell(1, MONDAY, "AM"), "blocked");
    expect(total()).toHaveTextContent("1");
  });

  it("posts a blocked action with its note", async () => {
    const user = userEvent.setup();
    setUpServer();
    const bodies = captureBulkBodies();
    renderWithProviders(<LeavePlanningPage />);

    await user.click(await findCell(1, MONDAY, "AM"));
    const popover = screen.getByTestId("planning-cell-popover");
    await user.selectOptions(within(popover).getByTestId("planning-cell-state-select"), "blocked");
    await user.type(within(popover).getByTestId("planning-cell-notes-input"), "Training");
    await user.click(within(popover).getByTestId("planning-cell-apply"));
    await user.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(bodies).toHaveLength(1));
    expect(bodies[0].actions).toEqual([
      { doctor_id: 1, date: MONDAY, period: "AM", action: "blocked", notes: "Training" },
    ]);
  });

  it("updates the cover total live as cells are toggled, before any save", async () => {
    const user = userEvent.setup();
    setUpServer();
    renderWithProviders(<LeavePlanningPage />);

    const total = () => screen.getByTestId(`planning-total-${MONDAY}-AM`);
    await waitFor(() => expect(total()).toHaveTextContent("2"));

    // Leave for AA, so cover drops to 1.
    await pickCellState(user, await findCell(1, MONDAY, "AM"), "leave");
    expect(total()).toHaveTextContent("1");

    // Extra planned instead. AA already worked this slot, so the override
    // is a no-op and cover comes back to 2 - not 3.
    await pickCellState(user, cell(1, MONDAY, "AM"), "extra_session");
    expect(total()).toHaveTextContent("2");

    // Back to normal, and the edit stops counting as unsaved.
    await pickCellState(user, cell(1, MONDAY, "AM"), "normal");
    expect(total()).toHaveTextContent("2");
    expect(screen.queryByTestId("planning-unsaved-count")).not.toBeInTheDocument();
  });

  it("raises the total for an extra session on a slot the doctor does not normally work", async () => {
    const user = userEvent.setup();
    setUpServer({ coverage: coverageFor([MONDAY, TUESDAY], 0) });
    renderWithProviders(<LeavePlanningPage />);

    // Tuesday has no template row at all, so an extra session there is a
    // genuine +1 (the copy loop's new-row branch).
    await pickCellState(user, await findCell(1, TUESDAY, "AM"), "extra_session");

    expect(cell(1, TUESDAY, "AM")).toHaveAttribute("data-state", "extra_session");
    expect(screen.getByTestId(`planning-total-${TUESDAY}-AM`)).toHaveTextContent("1");
  });

  it("counts unsaved edits and clears them on Discard", async () => {
    const user = userEvent.setup();
    setUpServer();
    renderWithProviders(<LeavePlanningPage />);

    await pickCellState(user, await findCell(1, MONDAY, "AM"), "leave");
    await pickCellState(user, cell(2, MONDAY, "PM"), "leave");
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

    await pickCellState(user, await findCell(1, MONDAY, "AM"), "leave");
    await pickCellState(user, cell(2, TUESDAY, "PM"), "extra_session");
    await user.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(bodies).toHaveLength(1));
    expect(bodies[0].actions).toEqual([
      { doctor_id: 1, date: MONDAY, period: "AM", action: "leave", notes: null },
      { doctor_id: 2, date: TUESDAY, period: "PM", action: "extra_session", notes: null },
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
    await pickCellState(user, await findCell(1, MONDAY, "AM"), "extra_session");
    await user.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(bodies).toHaveLength(1));
    expect(bodies[0].actions).toEqual([
      { doctor_id: 1, date: MONDAY, period: "AM", action: "clear" },
      { doctor_id: 1, date: MONDAY, period: "AM", action: "extra_session", notes: null },
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

    await pickCellState(user, await findCell(1, MONDAY, "AM"), "leave");
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

    await pickCellState(user, await findCell(1, MONDAY, "AM"), "leave");
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

  function renderWithElsewhereLink() {
    return renderWithProviders(
      <>
        <Link to="/elsewhere">Elsewhere</Link>
        <LeavePlanningPage />
      </>,
      { additionalRoutes: [{ path: "/elsewhere", element: <p>Somewhere else</p> }] },
    );
  }

  describe("drag range selection", () => {
    /** Both partners in surgery every weekday of the first week, so a
     * range's effect on the cover row is visible on every day it spans -
     * the default TEMPLATE only staffs Monday. */
    const FULL_WEEK_TEMPLATE = makeMasterRotaTemplate({
      sessions: WEEK.flatMap((date) =>
        [1, 2].flatMap((doctorId) =>
          (["AM", "PM"] as const).map((period) =>
            makeMasterRotaSession({
              doctor_id: doctorId,
              week: 1,
              // The grid maps a date onto its template day the same way.
              day: weekdayName(date)!,
              period,
            }),
          ),
        ),
      ),
    });

    function setUpWeek() {
      setUpServer({ coverage: coverageFor(WEEK, 2), template: FULL_WEEK_TEMPLATE });
    }

    /** A drag along one doctor's row, cell by cell - userEvent does not
     * synthesise the intermediate mouseenters a real drag produces. */
    function dragRow(doctorId: number, halves: [string, "AM" | "PM"][]) {
      const targets = halves.map(([date, period]) => cell(doctorId, date, period));
      fireEvent.mouseDown(targets[0], { button: 0 });
      for (const target of targets.slice(1)) fireEvent.mouseEnter(target);
      fireEvent.mouseUp(targets[targets.length - 1]);
    }

    async function applyRange(
      user: ReturnType<typeof userEvent.setup>,
      state: "normal" | "leave" | "extra_session" | "blocked",
    ) {
      const popover = screen.getByTestId("planning-cell-popover");
      await user.selectOptions(within(popover).getByTestId("planning-cell-state-select"), state);
      await user.click(within(popover).getByTestId("planning-cell-apply"));
    }

    it("records one unsaved change per half-day of a Mon-Fri drag", async () => {
      const user = userEvent.setup();
      setUpWeek();
      renderWithProviders(<LeavePlanningPage />);

      await findCell(1, MONDAY, "AM");
      dragRow(1, [
        [MONDAY, "AM"],
        [WEDNESDAY, "AM"],
        [FRIDAY, "PM"],
      ]);
      await applyRange(user, "leave");

      expect(screen.getByTestId("planning-unsaved-count")).toHaveTextContent("10 unsaved changes");
    });

    it("drops the cover total across the whole dragged range, not just its anchor", async () => {
      const user = userEvent.setup();
      setUpWeek();
      renderWithProviders(<LeavePlanningPage />);

      await findCell(1, MONDAY, "AM");
      await waitFor(() =>
        expect(screen.getByTestId(`planning-total-${FRIDAY}-PM`)).toHaveTextContent("2"),
      );

      dragRow(1, [
        [MONDAY, "PM"],
        [WEDNESDAY, "AM"],
        [FRIDAY, "PM"],
      ]);
      await applyRange(user, "leave");

      // The drag started on Monday PM, so Monday AM is untouched and
      // every slot from Monday PM onwards loses AA.
      expect(screen.getByTestId(`planning-total-${MONDAY}-AM`)).toHaveTextContent("2");
      expect(screen.getByTestId(`planning-total-${MONDAY}-PM`)).toHaveTextContent("1");
      expect(screen.getByTestId(`planning-total-${WEDNESDAY}-AM`)).toHaveTextContent("1");
      expect(screen.getByTestId(`planning-total-${FRIDAY}-PM`)).toHaveTextContent("1");
    });

    it("posts one action per cell of the range, with the drag's half-day edges", async () => {
      const user = userEvent.setup();
      setUpWeek();
      const bodies = captureBulkBodies();
      renderWithProviders(<LeavePlanningPage />);

      await findCell(1, MONDAY, "AM");
      // Off at lunchtime Monday, back at lunchtime Wednesday.
      dragRow(1, [
        [MONDAY, "PM"],
        [TUESDAY, "AM"],
        [WEDNESDAY, "AM"],
      ]);
      await applyRange(user, "leave");
      await user.click(screen.getByRole("button", { name: "Save" }));

      await waitFor(() => expect(bodies).toHaveLength(1));
      expect(bodies[0].actions).toEqual([
        { doctor_id: 1, date: MONDAY, period: "PM", action: "leave", notes: null },
        { doctor_id: 1, date: TUESDAY, period: "AM", action: "leave", notes: null },
        { doctor_id: 1, date: TUESDAY, period: "PM", action: "leave", notes: null },
        { doctor_id: 1, date: WEDNESDAY, period: "AM", action: "leave", notes: null },
      ]);
    });

    it("keeps the unsaved count honest for cells in a range that already matched", async () => {
      const user = userEvent.setup();
      setUpServer({
        coverage: coverageFor(WEEK, 2),
        template: FULL_WEEK_TEMPLATE,
        leave: [makeLeaveEntry({ doctor_id: 1, date: MONDAY, period: "AM" })],
      });
      renderWithProviders(<LeavePlanningPage />);

      expect(await findCell(1, MONDAY, "AM")).toHaveAttribute("data-state", "leave");
      dragRow(1, [
        [MONDAY, "AM"],
        [MONDAY, "PM"],
        [TUESDAY, "AM"],
      ]);
      await applyRange(user, "leave");

      // Three cells selected, but Monday AM was already leave on the
      // server, so only two of them are actual edits.
      expect(screen.getByTestId("planning-unsaved-count")).toHaveTextContent("2 unsaved changes");
    });
  });

  it("navigates immediately when there are no unsaved changes", async () => {
    const user = userEvent.setup();
    setUpServer();
    renderWithElsewhereLink();

    await findCell(1, MONDAY, "AM");
    await user.click(screen.getByRole("link", { name: "Elsewhere" }));

    expect(await screen.findByText("Somewhere else")).toBeInTheDocument();
    expect(screen.queryByTestId("unsaved-changes-dialog")).not.toBeInTheDocument();
  });

  it("blocks navigation with a Save/Discard/Cancel dialog when changes are unsaved", async () => {
    const user = userEvent.setup();
    setUpServer();
    renderWithElsewhereLink();

    await pickCellState(user, await findCell(1, MONDAY, "AM"), "leave");
    await user.click(screen.getByRole("link", { name: "Elsewhere" }));

    const dialog = await screen.findByTestId("unsaved-changes-dialog");
    expect(screen.queryByText("Somewhere else")).not.toBeInTheDocument();

    await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(screen.queryByTestId("unsaved-changes-dialog")).not.toBeInTheDocument();
    expect(cell(1, MONDAY, "AM")).toHaveAttribute("data-state", "leave");
  });

  it("discards pending edits and navigates away when Discard is chosen", async () => {
    const user = userEvent.setup();
    setUpServer();
    renderWithElsewhereLink();

    await pickCellState(user, await findCell(1, MONDAY, "AM"), "leave");
    await user.click(screen.getByRole("link", { name: "Elsewhere" }));
    const dialog = await screen.findByTestId("unsaved-changes-dialog");
    await user.click(within(dialog).getByRole("button", { name: "Discard" }));

    expect(await screen.findByText("Somewhere else")).toBeInTheDocument();
  });

  it("saves pending edits then navigates away when Save is chosen", async () => {
    const user = userEvent.setup();
    setUpServer();
    const bodies = captureBulkBodies();
    renderWithElsewhereLink();

    await pickCellState(user, await findCell(1, MONDAY, "AM"), "leave");
    await user.click(screen.getByRole("link", { name: "Elsewhere" }));
    const dialog = await screen.findByTestId("unsaved-changes-dialog");
    await user.click(within(dialog).getByRole("button", { name: "Save" }));

    await waitFor(() => expect(bodies).toHaveLength(1));
    expect(await screen.findByText("Somewhere else")).toBeInTheDocument();
  });

  describe("doctor selection", () => {
    it("highlights the row and shows the doctor's leave balance", async () => {
      const user = userEvent.setup();
      setUpServer();
      stubEntitlement([
        makeLeaveEntitlement({
          doctor_id: 2,
          doctor_code: "BB",
          entitlement_sessions: "49.0",
          used_sessions: 0,
          remaining_sessions: "49.0",
        }),
      ]);
      renderWithProviders(<LeavePlanningPage />);

      await user.click(await screen.findByTestId("planning-doctor-label-2"));

      expect(screen.getByTestId("planning-row-2")).toHaveAttribute("data-row-selected", "true");
      const panel = await screen.findByTestId("planning-selected-doctor");
      expect(panel).toHaveTextContent("BB");
      expect(panel).toHaveTextContent("Leave 2026:");
      expect(panel).toHaveTextContent("0/49");
      expect(panel).toHaveTextContent("49 remaining");
    });

    it("clears the highlight when the same doctor is clicked again", async () => {
      const user = userEvent.setup();
      setUpServer();
      stubEntitlement([makeLeaveEntitlement({ doctor_id: 2, doctor_code: "BB" })]);
      renderWithProviders(<LeavePlanningPage />);

      const label = await screen.findByTestId("planning-doctor-label-2");
      await user.click(label);
      expect(await screen.findByTestId("planning-selected-doctor")).toBeInTheDocument();

      await user.click(label);
      expect(screen.queryByTestId("planning-selected-doctor")).not.toBeInTheDocument();
      expect(screen.getByTestId("planning-row-2")).toHaveAttribute("data-row-selected", "false");
    });

    it("says so for a doctor with no tracked entitlement", async () => {
      const user = userEvent.setup();
      setUpServer({ doctors: [AA, LOCUM] });
      stubEntitlement([makeLeaveEntitlement({ doctor_id: 1, doctor_code: "AA" })]);
      renderWithProviders(<LeavePlanningPage />);

      await user.click(await screen.findByTestId(`planning-doctor-label-${LOCUM.id}`));

      const panel = await screen.findByTestId("planning-selected-doctor");
      expect(panel).toHaveTextContent("No leave entitlement is tracked for this doctor.");
    });

    it("asks for the viewed month's leave year when the month steps into the next one", async () => {
      const user = userEvent.setup();
      setUpServer();
      const years = stubEntitlement([makeLeaveEntitlement({ doctor_id: 2, doctor_code: "BB" })]);
      renderWithProviders(<LeavePlanningPage />);

      await user.click(await screen.findByTestId("planning-doctor-label-2"));
      await waitFor(() => expect(years).toContain("2026"));

      // August 2026 -> five steps forward lands in January 2027.
      for (let i = 0; i < 5; i += 1) {
        await user.click(screen.getByRole("button", { name: "Next" }));
      }

      await waitFor(() => expect(years).toContain("2027"));
      expect(await screen.findByTestId("planning-selected-doctor")).toHaveTextContent(
        "Leave 2027:",
      );
    });
  });

  describe("the linked doctor default", () => {
    const LINKED_BB = { linked_doctor: { id: 2, code: "BB", active: true } };

    it("opens on the doctor this login is linked to", async () => {
      setUpServer();
      stubEntitlement([makeLeaveEntitlement({ doctor_id: 2, doctor_code: "BB" })]);
      renderWithProviders(<LeavePlanningPage />, { authUser: LINKED_BB });

      expect(await screen.findByTestId("planning-selected-doctor")).toHaveTextContent("BB");
      expect(screen.getByTestId("planning-row-2")).toHaveAttribute("data-row-selected", "true");
    });

    it("opens with no doctor selected for an unlinked user", async () => {
      setUpServer();
      stubEntitlement([makeLeaveEntitlement({ doctor_id: 2, doctor_code: "BB" })]);
      renderWithProviders(<LeavePlanningPage />);

      expect(await screen.findByTestId("planning-row-2")).toHaveAttribute(
        "data-row-selected",
        "false",
      );
      expect(screen.queryByTestId("planning-selected-doctor")).not.toBeInTheDocument();
    });

    it("lets the linked user select another doctor, and keeps it across a re-render", async () => {
      const user = userEvent.setup();
      setUpServer();
      stubEntitlement([
        makeLeaveEntitlement({ doctor_id: 1, doctor_code: "AA" }),
        makeLeaveEntitlement({ doctor_id: 2, doctor_code: "BB" }),
      ]);
      renderWithProviders(<LeavePlanningPage />, { authUser: LINKED_BB });

      await user.click(await screen.findByTestId("planning-doctor-label-1"));
      expect(await screen.findByTestId("planning-selected-doctor")).toHaveTextContent("AA");

      // A month change re-renders the page; the default must not be
      // re-applied over the user's own pick.
      await user.click(screen.getByRole("button", { name: "Next" }));
      expect(await screen.findByText("September 2026")).toBeInTheDocument();
      expect(screen.getByTestId("planning-selected-doctor")).toHaveTextContent("AA");
    });

    it("still clears the highlight when the linked doctor's own label is clicked", async () => {
      const user = userEvent.setup();
      setUpServer();
      stubEntitlement([makeLeaveEntitlement({ doctor_id: 2, doctor_code: "BB" })]);
      renderWithProviders(<LeavePlanningPage />, { authUser: LINKED_BB });

      await user.click(await screen.findByTestId("planning-doctor-label-2"));

      expect(screen.queryByTestId("planning-selected-doctor")).not.toBeInTheDocument();
    });
  });
});
