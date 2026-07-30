import { useState } from "react";

import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import type { SchoolHoliday } from "@/api/types";
import { closedSlotKey } from "@/lib/closedSlots";
import { formatHolidayRange } from "@/lib/date";
import { type PendingEdit, planningCellKey } from "@/lib/planningMonth";
import { makeDoctor, makeSchoolHoliday } from "@/test/fixtures/reference";

import { LeavePlanningGrid } from "./LeavePlanningGrid";

const MONDAY = "2026-08-03";
const TUESDAY = "2026-08-04";

const AA = makeDoctor({ id: 1, code: "AA", doctor_type: "Partner" });
const BB = makeDoctor({ id: 2, code: "BB", doctor_type: "Salaried" });

function renderGrid(overrides: Partial<Parameters<typeof LeavePlanningGrid>[0]> = {}) {
  const onApply = vi.fn();
  render(
    <LeavePlanningGrid
      dates={[MONDAY, TUESDAY]}
      year={2026}
      month={8}
      doctors={[AA, BB]}
      schoolRows={[]}
      pending={new Map<string, PendingEdit>()}
      leaveKeys={new Set()}
      extraKeys={new Set()}
      blockedKeys={new Set()}
      leaveNotes={new Map()}
      extraNotes={new Map()}
      blockedNotes={new Map()}
      closedSlots={new Set()}
      totals={new Map()}
      templateTypes={new Map()}
      onApply={onApply}
      {...overrides}
    />,
  );
  return { onApply };
}

/** A single-date school row, built from a real holiday fixture so the
 * title text matches formatHolidayRange. */
function schoolRow(id: number, name: string, date: string, holiday: SchoolHoliday = makeSchoolHoliday()) {
  return { id, name, dates: new Map([[date, holiday]]) };
}

function cell(doctorId: number, date: string, period: "AM" | "PM") {
  return screen.getByTestId(`planning-cell-${doctorId}-${date}-${period}`);
}

/** Opens the cell's popover, picks a status from the dropdown, optionally
 * types a note, then clicks Apply - the only way to change a cell's state
 * now that clicking opens `PlanningCellPopover` instead of cycling. */
async function pickCellState(
  user: ReturnType<typeof userEvent.setup>,
  target: HTMLElement,
  state: "normal" | "leave" | "extra_session" | "blocked",
  notes?: string,
) {
  await user.click(target);
  const popover = screen.getByTestId("planning-cell-popover");
  await user.selectOptions(within(popover).getByTestId("planning-cell-state-select"), state);
  if (notes !== undefined) {
    const notesInput = within(popover).getByTestId("planning-cell-notes-input");
    await user.clear(notesInput);
    await user.type(notesInput, notes);
  }
  await user.click(within(popover).getByTestId("planning-cell-apply"));
}

/**
 * The minimum of what the page does with `onApply` - hold the pending
 * map and feed it back in. The grid is stateless, so a state change is
 * only observable through a parent that stores what Apply reported.
 */
function EditHarness() {
  const [pending, setPending] = useState<Map<string, PendingEdit>>(new Map());
  return (
    <LeavePlanningGrid
      dates={[MONDAY, TUESDAY]}
      year={2026}
      month={8}
      doctors={[AA, BB]}
      schoolRows={[]}
      pending={pending}
      leaveKeys={new Set()}
      extraKeys={new Set()}
      blockedKeys={new Set()}
      leaveNotes={new Map()}
      extraNotes={new Map()}
      blockedNotes={new Map()}
      closedSlots={new Set()}
      totals={new Map()}
      templateTypes={new Map()}
      onApply={(doctorId, date, period, state, notes) =>
        setPending(
          new Map([[planningCellKey(doctorId, date, period), { action: state === "normal" ? "clear" : state, notes }]]),
        )
      }
    />
  );
}

describe("LeavePlanningGrid", () => {
  it("renders a row per doctor and a column per date", () => {
    renderGrid();

    expect(screen.getByText("AA")).toBeInTheDocument();
    expect(screen.getByText("BB")).toBeInTheDocument();
    expect(screen.getByTestId(`planning-header-${MONDAY}`)).toHaveTextContent("Mon");
    expect(screen.getByTestId(`planning-header-${TUESDAY}`)).toHaveTextContent("Tue");
    // AM and PM halves for every (doctor, date).
    expect(cell(1, MONDAY, "AM")).toBeInTheDocument();
    expect(cell(1, MONDAY, "PM")).toBeInTheDocument();
  });

  it("flags a lead-in/lead-out date from an adjacent month as out of month", () => {
    // 2026-07-31 is a Friday borrowed to complete August's first week.
    renderGrid({ dates: ["2026-07-31", MONDAY], year: 2026, month: 8 });

    expect(screen.getByTestId("planning-header-2026-07-31")).toHaveAttribute(
      "data-out-of-month",
      "true",
    );
    expect(screen.getByTestId(`planning-header-${MONDAY}`)).toHaveAttribute(
      "data-out-of-month",
      "false",
    );
  });

  it("shows a cell with no rows as normal", () => {
    renderGrid();
    expect(cell(1, MONDAY, "AM")).toHaveAttribute("data-state", "normal");
  });

  it("renders existing leave and extra sessions from the server rows", () => {
    renderGrid({
      leaveKeys: new Set([planningCellKey(1, MONDAY, "AM")]),
      extraKeys: new Set([planningCellKey(2, TUESDAY, "PM")]),
    });

    expect(cell(1, MONDAY, "AM")).toHaveAttribute("data-state", "leave");
    expect(cell(2, TUESDAY, "PM")).toHaveAttribute("data-state", "extra_session");
  });

  it("shows leave in preference to an extra session where both rows exist", () => {
    const key = planningCellKey(1, MONDAY, "AM");
    renderGrid({ leaveKeys: new Set([key]), extraKeys: new Set([key]) });

    expect(cell(1, MONDAY, "AM")).toHaveAttribute("data-state", "leave");
  });

  it("lets a pending edit override the server row", () => {
    renderGrid({
      leaveKeys: new Set([planningCellKey(1, MONDAY, "AM")]),
      pending: new Map([[planningCellKey(1, MONDAY, "AM"), { action: "clear", notes: "" } as PendingEdit]]),
    });

    const target = cell(1, MONDAY, "AM");
    expect(target).toHaveAttribute("data-state", "normal");
    expect(target).toHaveAttribute("data-pending", "true");
  });

  it("reports the picked state and notes when Apply is pressed", async () => {
    const user = userEvent.setup();
    const { onApply } = renderGrid();

    await pickCellState(user, cell(1, MONDAY, "AM"), "blocked", "Training");

    expect(onApply).toHaveBeenCalledWith(1, MONDAY, "AM", "blocked", "Training");
  });

  it("moves a cell through every state via the popover, without firing a request", async () => {
    const user = userEvent.setup();
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    render(<EditHarness />);

    const target = () => cell(1, MONDAY, "AM");
    expect(target()).toHaveAttribute("data-state", "normal");

    await pickCellState(user, target(), "leave");
    expect(target()).toHaveAttribute("data-state", "leave");

    await pickCellState(user, target(), "extra_session");
    expect(target()).toHaveAttribute("data-state", "extra_session");

    await pickCellState(user, target(), "blocked", "Course");
    expect(target()).toHaveAttribute("data-state", "blocked");
    expect(target()).toHaveTextContent("Course");

    await pickCellState(user, target(), "normal");
    expect(target()).toHaveAttribute("data-state", "normal");

    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it("shows the note in place of the AM/PM label, capped by the input's maxlength", async () => {
    const user = userEvent.setup();
    renderGrid({
      blockedKeys: new Set([planningCellKey(1, MONDAY, "AM")]),
      blockedNotes: new Map([[planningCellKey(1, MONDAY, "AM"), "Training"]]),
    });

    const target = cell(1, MONDAY, "AM");
    expect(target).toHaveTextContent("Training");

    await user.click(target);
    const popover = screen.getByTestId("planning-cell-popover");
    expect(within(popover).getByTestId("planning-cell-notes-input")).toHaveAttribute("maxlength", "12");
  });

  it("renders a closed slot inert, with no click handler", async () => {
    const user = userEvent.setup();
    const { onApply } = renderGrid({
      closedSlots: new Set([closedSlotKey(MONDAY, "AM")]),
    });

    const target = cell(1, MONDAY, "AM");
    expect(target).toHaveAttribute("data-state", "closed");
    await user.click(target);
    expect(onApply).not.toHaveBeenCalled();
    expect(screen.queryByTestId("planning-cell-popover")).not.toBeInTheDocument();
    // The other half of the same day is unaffected - closures are
    // half-day granular.
    expect(cell(1, MONDAY, "PM")).toHaveAttribute("data-state", "normal");
  });

  it("greys the column header for a fully closed day", () => {
    renderGrid({
      closedSlots: new Set([closedSlotKey(MONDAY, "AM"), closedSlotKey(MONDAY, "PM")]),
    });

    expect(screen.getByTestId(`planning-header-${MONDAY}`).className).toContain("closed-hatch");
    expect(screen.getByTestId(`planning-header-${TUESDAY}`).className).not.toContain("closed-hatch");
  });

  it("renders an out-of-window cell inert, and distinguishably from a closed one", async () => {
    const user = userEvent.setup();
    const leaver = makeDoctor({ id: 3, code: "CC", doctor_type: "Partner", end_date: MONDAY });
    const { onApply } = renderGrid({
      doctors: [leaver],
      closedSlots: new Set([closedSlotKey(MONDAY, "AM")]),
    });

    const outOfWindow = cell(3, TUESDAY, "AM");
    expect(outOfWindow).toHaveAttribute("data-state", "out_of_window");
    await user.click(outOfWindow);
    expect(onApply).not.toHaveBeenCalled();

    // Distinct treatments: black hatching for closed, plain absent grey for
    // not-employed. Confusing the two would mislead.
    expect(cell(3, MONDAY, "AM").className).toContain("closed-hatch");
    expect(outOfWindow.className).not.toContain("closed-hatch");
  });

  it("still offers the in-window part of a leaver's month", () => {
    const leaver = makeDoctor({ id: 3, code: "CC", doctor_type: "Partner", end_date: MONDAY });
    renderGrid({ doctors: [leaver] });

    expect(cell(3, MONDAY, "AM")).toHaveAttribute("data-state", "normal");
    expect(cell(3, TUESDAY, "AM")).toHaveAttribute("data-state", "out_of_window");
  });

  it("renders the total row, with an em dash for a closed slot", () => {
    renderGrid({
      totals: new Map<string, number | null>([
        [closedSlotKey(MONDAY, "AM"), 4],
        [closedSlotKey(MONDAY, "PM"), 0],
        [closedSlotKey(TUESDAY, "AM"), null],
      ]),
    });

    expect(screen.getByTestId(`planning-total-${MONDAY}-AM`)).toHaveTextContent("4");
    // Zero is a real, meaningful number here - uncovered, not closed.
    expect(screen.getByTestId(`planning-total-${MONDAY}-PM`)).toHaveTextContent("0");
    expect(screen.getByTestId(`planning-total-${TUESDAY}-AM`)).toHaveTextContent("—");
  });

  it("flags thin cover by threshold: 0-2 red, 3 orange, 4 yellow, 5+ neutral", () => {
    renderGrid({
      totals: new Map<string, number | null>([
        [closedSlotKey(MONDAY, "AM"), 2],
        [closedSlotKey(MONDAY, "PM"), 3],
        [closedSlotKey(TUESDAY, "AM"), 4],
        [closedSlotKey(TUESDAY, "PM"), 5],
      ]),
    });

    expect(screen.getByTestId(`planning-total-${MONDAY}-AM`).className).toContain("bg-red-200");
    expect(screen.getByTestId(`planning-total-${MONDAY}-PM`).className).toContain("bg-orange-200");
    expect(screen.getByTestId(`planning-total-${TUESDAY}-AM`).className).toContain("bg-yellow-200");
    expect(screen.getByTestId(`planning-total-${TUESDAY}-PM`).className).not.toMatch(
      /bg-(red|orange|yellow)-200/,
    );
  });

  it("keeps a closed slot's total neutral rather than flagging it", () => {
    renderGrid({
      totals: new Map<string, number | null>([[closedSlotKey(MONDAY, "AM"), null]]),
    });

    expect(screen.getByTestId(`planning-total-${MONDAY}-AM`).className).not.toMatch(
      /bg-(red|orange|yellow)-100/,
    );
  });

  it("shows a weekly total below the daily row, summing AM+PM across the week", () => {
    renderGrid({
      totals: new Map<string, number | null>([
        [closedSlotKey(MONDAY, "AM"), 4],
        [closedSlotKey(MONDAY, "PM"), 3],
        [closedSlotKey(TUESDAY, "AM"), 5],
        [closedSlotKey(TUESDAY, "PM"), null],
      ]),
    });

    // Closed slots contribute nothing, so this is 4 + 3 + 5.
    expect(screen.getByTestId(`planning-weekly-total-${MONDAY}`)).toHaveTextContent("12");
  });

  it("shows an em dash for a week that is entirely closed", () => {
    renderGrid({
      totals: new Map<string, number | null>([
        [closedSlotKey(MONDAY, "AM"), null],
        [closedSlotKey(MONDAY, "PM"), null],
        [closedSlotKey(TUESDAY, "AM"), null],
        [closedSlotKey(TUESDAY, "PM"), null],
      ]),
    });

    expect(screen.getByTestId(`planning-weekly-total-${MONDAY}`)).toHaveTextContent("—");
  });

  it("shows an empty-state message when no doctors work the month", () => {
    renderGrid({ doctors: [] });
    expect(
      screen.getByText("No partners, salaried doctors, or locums work this month."),
    ).toBeInTheDocument();
  });

  it("renders a school row above the doctor rows, shading only the dates in its holiday", () => {
    const holiday = makeSchoolHoliday();
    renderGrid({ schoolRows: [schoolRow(1, "St Mary's", MONDAY, holiday)] });

    expect(screen.getByText("St Mary's")).toBeInTheDocument();
    const holidayCell = screen.getByTestId(`planning-school-cell-1-${MONDAY}`);
    expect(holidayCell).toHaveAttribute("data-state", "school_holiday");
    expect(holidayCell).toHaveAttribute(
      "title",
      `St Mary's: ${formatHolidayRange(holiday.start_date, holiday.end_date)}`,
    );
    expect(screen.getByTestId(`planning-school-cell-1-${TUESDAY}`)).toHaveAttribute(
      "data-state",
      "normal",
    );
  });

  it("renders a school cell as inert, with no button", () => {
    renderGrid({ schoolRows: [schoolRow(1, "St Mary's", MONDAY)] });
    expect(
      screen.getByTestId(`planning-school-cell-1-${MONDAY}`).querySelector("button"),
    ).not.toBeInTheDocument();
  });
});
