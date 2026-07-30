import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { makeLeaveEntry } from "@/test/fixtures/reference";

import { LeaveYearCalendar } from "./LeaveYearCalendar";

describe("LeaveYearCalendar", () => {
  it("marks a day with both AM and PM leave as full and a half-day as half", () => {
    render(
      <LeaveYearCalendar
        year={2026}
        onPrevYear={vi.fn()}
        onNextYear={vi.fn()}
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
        onPrevYear={vi.fn()}
        onNextYear={vi.fn()}
        entries={[makeLeaveEntry({ date: "2027-08-03", period: "AM" })]}
      />,
    );

    expect(screen.getByTestId("year-cal-2026-08-03")).toHaveAttribute("data-state", "none");
  });

  it("calls onPrevYear/onNextYear from the year switcher", async () => {
    const user = userEvent.setup();
    const onPrevYear = vi.fn();
    const onNextYear = vi.fn();
    render(<LeaveYearCalendar year={2026} onPrevYear={onPrevYear} onNextYear={onNextYear} entries={[]} />);

    await user.click(screen.getByLabelText("Previous year"));
    await user.click(screen.getByLabelText("Next year"));

    expect(onPrevYear).toHaveBeenCalledTimes(1);
    expect(onNextYear).toHaveBeenCalledTimes(1);
  });
});
