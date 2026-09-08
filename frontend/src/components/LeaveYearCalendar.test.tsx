import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { makeLeaveEntry } from "@/test/fixtures/reference";

import { LeaveYearCalendar } from "./LeaveYearCalendar";

describe("LeaveYearCalendar", () => {
  it("marks a day with both AM and PM leave as full and a half-day as half", () => {
    render(
      <LeaveYearCalendar
        year={2026}
        entries={[
          makeLeaveEntry({ date: "2026-08-03", period: "AM" }),
          makeLeaveEntry({ date: "2026-08-03", period: "PM" }),
          makeLeaveEntry({ date: "2026-08-04", period: "AM" }),
        ]}
      />,
    );

    expect(screen.getByTestId("year-cal-2026-08-03")).toHaveAttribute("data-state", "full");
    expect(screen.getByTestId("year-cal-2026-08-04")).toHaveAttribute("data-state", "half");
    expect(screen.getByTestId("year-cal-2026-08-05")).toHaveAttribute("data-state", "none");
  });

  it("ignores entries outside the displayed year", () => {
    render(
      <LeaveYearCalendar
        year={2026}
        entries={[makeLeaveEntry({ date: "2027-08-03", period: "AM" })]}
      />,
    );

    expect(screen.getByTestId("year-cal-2026-08-03")).toHaveAttribute("data-state", "none");
  });

  it("captions the year without offering its own year control", () => {
    // The year is chosen once, by the shared Session Management control.
    render(<LeaveYearCalendar year={2026} entries={[]} />);

    expect(screen.getByText("2026")).toBeInTheDocument();
    expect(screen.queryByLabelText("Previous year")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Next year")).not.toBeInTheDocument();
  });
});
