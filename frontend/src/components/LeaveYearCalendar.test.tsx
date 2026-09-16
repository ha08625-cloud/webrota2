import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { makeExtraSessionEntry, makeLeaveEntry } from "@/test/fixtures/reference";

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

  it("marks extra sessions in their own state, full for both halves", () => {
    render(
      <LeaveYearCalendar
        year={2026}
        entries={[]}
        extraSessions={[
          makeExtraSessionEntry({ date: "2026-08-03", period: "AM" }),
          makeExtraSessionEntry({ date: "2026-08-03", period: "PM" }),
          makeExtraSessionEntry({ date: "2026-08-04", period: "AM" }),
          makeExtraSessionEntry({ date: "2027-08-05", period: "AM" }),
        ]}
      />,
    );

    expect(screen.getByTestId("year-cal-2026-08-03")).toHaveAttribute("data-state", "extra-full");
    expect(screen.getByTestId("year-cal-2026-08-04")).toHaveAttribute("data-state", "extra-half");
    // Outside the displayed year, same as leave.
    expect(screen.getByTestId("year-cal-2026-08-05")).toHaveAttribute("data-state", "none");
  });

  it("lets full-day leave win a day that also carries an extra session, and marks a split day as both", () => {
    render(
      <LeaveYearCalendar
        year={2026}
        entries={[
          makeLeaveEntry({ date: "2026-08-03", period: "AM" }),
          makeLeaveEntry({ date: "2026-08-03", period: "PM" }),
          makeLeaveEntry({ date: "2026-08-04", period: "AM" }),
        ]}
        extraSessions={[
          makeExtraSessionEntry({ date: "2026-08-03", period: "AM" }),
          makeExtraSessionEntry({ date: "2026-08-04", period: "PM" }),
        ]}
      />,
    );

    expect(screen.getByTestId("year-cal-2026-08-03")).toHaveAttribute("data-state", "full");
    expect(screen.getByTestId("year-cal-2026-08-04")).toHaveAttribute(
      "data-state",
      "leave-and-extra",
    );
  });

  it("names the compensation in an extra session day's title", () => {
    render(
      <LeaveYearCalendar
        year={2026}
        entries={[]}
        extraSessions={[
          makeExtraSessionEntry({ date: "2026-08-03", period: "AM", compensation: "TOIL" }),
          makeExtraSessionEntry({ date: "2026-08-04", period: "AM", compensation: "Payment" }),
          makeExtraSessionEntry({ date: "2026-08-04", period: "PM", compensation: "Payment" }),
        ]}
      />,
    );

    expect(screen.getByTestId("year-cal-2026-08-03")).toHaveAttribute(
      "title",
      "2026-08-03 - Extra session (half day) (TOIL)",
    );
    expect(screen.getByTestId("year-cal-2026-08-04")).toHaveAttribute(
      "title",
      "2026-08-04 - Extra session (AM and PM) (Payment)",
    );
  });

  it("says a day's extra session is superseded when leave covers it too", () => {
    // The durable form of the transient superseded-extra-sessions warning
    // the bulk endpoints report once - and why a TOIL session there earns
    // nothing.
    render(
      <LeaveYearCalendar
        year={2026}
        entries={[
          makeLeaveEntry({ date: "2026-08-03", period: "AM" }),
          makeLeaveEntry({ date: "2026-08-04", period: "AM" }),
          makeLeaveEntry({ date: "2026-08-04", period: "PM" }),
        ]}
        extraSessions={[
          makeExtraSessionEntry({ date: "2026-08-03", period: "PM", compensation: "TOIL" }),
          makeExtraSessionEntry({ date: "2026-08-04", period: "AM", compensation: "TOIL" }),
        ]}
      />,
    );

    expect(screen.getByTestId("year-cal-2026-08-03")).toHaveAttribute(
      "title",
      "2026-08-03 - Half-day leave and an extra session (TOIL) - the extra session is superseded by the leave",
    );
    // Full-day leave hides the extra session from the colour scale, but the
    // title still accounts for it rather than reading as plain leave.
    expect(screen.getByTestId("year-cal-2026-08-04")).toHaveAttribute(
      "title",
      "2026-08-04 - Leave (full day) (TOIL) - the extra session is superseded by the leave",
    );
  });

  it("captions the year without offering its own year control", () => {
    // The year is chosen once, by the shared Session Management control.
    render(<LeaveYearCalendar year={2026} entries={[]} />);

    expect(screen.getByText("2026")).toBeInTheDocument();
    expect(screen.queryByLabelText("Previous year")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Next year")).not.toBeInTheDocument();
  });
});
