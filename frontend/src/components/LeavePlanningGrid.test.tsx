import { useState } from "react";

import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import type { PlanningAction } from "@/api/types";
import { closedSlotKey } from "@/lib/closedSlots";
import { planningCellKey, stateToAction } from "@/lib/planningMonth";
import { makeDoctor } from "@/test/fixtures/reference";

import { LeavePlanningGrid } from "./LeavePlanningGrid";

const MONDAY = "2026-08-03";
const TUESDAY = "2026-08-04";

const AA = makeDoctor({ id: 1, code: "AA", doctor_type: "Partner" });
const BB = makeDoctor({ id: 2, code: "BB", doctor_type: "Salaried" });

function renderGrid(overrides: Partial<Parameters<typeof LeavePlanningGrid>[0]> = {}) {
  const onToggle = vi.fn();
  render(
    <LeavePlanningGrid
      dates={[MONDAY, TUESDAY]}
      year={2026}
      month={8}
      doctors={[AA, BB]}
      pending={new Map<string, PlanningAction>()}
      leaveKeys={new Set()}
      extraKeys={new Set()}
      closedSlots={new Set()}
      totals={new Map()}
      onToggle={onToggle}
      {...overrides}
    />,
  );
  return { onToggle };
}

function cell(doctorId: number, date: string, period: "AM" | "PM") {
  return screen.getByTestId(`planning-cell-${doctorId}-${date}-${period}`);
}

/**
 * The minimum of what the page does with `onToggle` - hold the pending
 * map and feed it back in. The grid is stateless, so the cycle is only
 * observable through a parent that stores what the click reported.
 */
function CycleHarness() {
  const [pending, setPending] = useState<Map<string, PlanningAction>>(new Map());
  return (
    <LeavePlanningGrid
      dates={[MONDAY, TUESDAY]}
      year={2026}
      month={8}
      doctors={[AA, BB]}
      pending={pending}
      leaveKeys={new Set()}
      extraKeys={new Set()}
      closedSlots={new Set()}
      totals={new Map()}
      onToggle={(doctorId, date, period, next) =>
        setPending(
          new Map([[planningCellKey(doctorId, date, period), stateToAction(next)]]),
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
      pending: new Map([[planningCellKey(1, MONDAY, "AM"), "clear" as PlanningAction]]),
    });

    const target = cell(1, MONDAY, "AM");
    expect(target).toHaveAttribute("data-state", "normal");
    expect(target).toHaveAttribute("data-pending", "true");
  });

  it("reports the state a click should move to", async () => {
    const user = userEvent.setup();
    const { onToggle } = renderGrid();

    await user.click(cell(1, MONDAY, "AM"));

    expect(onToggle).toHaveBeenCalledWith(1, MONDAY, "AM", "leave");
  });

  it("cycles normal -> leave -> extra planned -> normal, without firing a request", async () => {
    const user = userEvent.setup();
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    render(<CycleHarness />);

    const target = () => cell(1, MONDAY, "AM");
    expect(target()).toHaveAttribute("data-state", "normal");

    await user.click(target());
    expect(target()).toHaveAttribute("data-state", "leave");

    await user.click(target());
    expect(target()).toHaveAttribute("data-state", "extra_session");

    await user.click(target());
    expect(target()).toHaveAttribute("data-state", "normal");

    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it("renders a closed slot inert, with no click handler", async () => {
    const user = userEvent.setup();
    const { onToggle } = renderGrid({
      closedSlots: new Set([closedSlotKey(MONDAY, "AM")]),
    });

    const target = cell(1, MONDAY, "AM");
    expect(target).toHaveAttribute("data-state", "closed");
    await user.click(target);
    expect(onToggle).not.toHaveBeenCalled();
    // The other half of the same day is unaffected - closures are
    // half-day granular.
    expect(cell(1, MONDAY, "PM")).toHaveAttribute("data-state", "normal");
  });

  it("greys the column header for a fully closed day", () => {
    renderGrid({
      closedSlots: new Set([closedSlotKey(MONDAY, "AM"), closedSlotKey(MONDAY, "PM")]),
    });

    expect(screen.getByTestId(`planning-header-${MONDAY}`).className).toContain("bg-gray-200");
    expect(screen.getByTestId(`planning-header-${TUESDAY}`).className).not.toContain("bg-gray-200");
  });

  it("renders an out-of-window cell inert, and distinguishably from a closed one", async () => {
    const user = userEvent.setup();
    const leaver = makeDoctor({ id: 3, code: "CC", doctor_type: "Partner", end_date: MONDAY });
    const { onToggle } = renderGrid({
      doctors: [leaver],
      closedSlots: new Set([closedSlotKey(MONDAY, "AM")]),
    });

    const outOfWindow = cell(3, TUESDAY, "AM");
    expect(outOfWindow).toHaveAttribute("data-state", "out_of_window");
    await user.click(outOfWindow);
    expect(onToggle).not.toHaveBeenCalled();

    // Distinct treatments: solid grey for closed, plain absent grey for
    // not-employed. Confusing the two would mislead.
    expect(cell(3, MONDAY, "AM").className).toContain("bg-gray-200");
    expect(outOfWindow.className).not.toContain("bg-gray-200");
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

    expect(screen.getByTestId(`planning-total-${MONDAY}-AM`).className).toContain("bg-red-100");
    expect(screen.getByTestId(`planning-total-${MONDAY}-PM`).className).toContain("bg-orange-100");
    expect(screen.getByTestId(`planning-total-${TUESDAY}-AM`).className).toContain("bg-yellow-100");
    expect(screen.getByTestId(`planning-total-${TUESDAY}-PM`).className).not.toMatch(
      /bg-(red|orange|yellow)-100/,
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

  it("shows an empty-state message when no doctors work the month", () => {
    renderGrid({ doctors: [] });
    expect(
      screen.getByText("No partners or salaried doctors work this month."),
    ).toBeInTheDocument();
  });
});
