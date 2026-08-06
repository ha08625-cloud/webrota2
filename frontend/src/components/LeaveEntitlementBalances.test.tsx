import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { makeLeaveEntitlement } from "@/test/fixtures/reference";
import { renderWithProviders } from "@/test/renderWithProviders";

import { LeaveEntitlementBalances } from "./LeaveEntitlementBalances";

function render(props: Partial<Parameters<typeof LeaveEntitlementBalances>[0]> = {}) {
  return renderWithProviders(
    <LeaveEntitlementBalances
      year={2026}
      onPrevYear={props.onPrevYear ?? vi.fn()}
      onNextYear={props.onNextYear ?? vi.fn()}
      rows={props.rows ?? []}
      isLoading={props.isLoading}
      isError={props.isError}
    />,
  );
}

/** The row for `code`, so column assertions can't accidentally match another doctor's cell. */
function rowFor(code: string): HTMLElement {
  return screen.getByRole("cell", { name: code }).closest("tr") as HTMLElement;
}

describe("LeaveEntitlementBalances", () => {
  it("renders a row per doctor with entitlement, used and remaining", () => {
    render({
      rows: [
        makeLeaveEntitlement({
          doctor_id: 1,
          doctor_code: "AB",
          entitlement_sessions: "36.0",
          used_sessions: 10,
          remaining_sessions: "26.0",
        }),
        makeLeaveEntitlement({
          doctor_id: 2,
          doctor_code: "CD",
          doctor_type: "Partner",
          sessions_per_week: "10.0",
          weeks: "7",
          entitlement_sessions: "70.0",
          used_sessions: 4,
          remaining_sessions: "66.0",
          template_sessions_per_week: 10,
        }),
      ],
    });

    expect(within(rowFor("AB")).getByText("36")).toBeInTheDocument();
    expect(within(rowFor("AB")).getByText("10")).toBeInTheDocument();
    expect(screen.getByTestId("remaining-AB")).toHaveTextContent("26");
    expect(screen.getByTestId("remaining-CD")).toHaveTextContent("66");
  });

  it("drops a trailing .0 but keeps a real fraction", () => {
    render({
      rows: [makeLeaveEntitlement({ entitlement_sessions: "18.1", remaining_sessions: "18.1" })],
    });

    expect(screen.getByTestId("remaining-AB")).toHaveTextContent("18.1");
  });

  it("shows an over-booked doctor as a negative remaining balance", () => {
    render({
      rows: [
        makeLeaveEntitlement({ used_sessions: 40, remaining_sessions: "-4.0" }),
      ],
    });

    const cell = screen.getByTestId("remaining-AB");
    expect(cell).toHaveTextContent("-4");
    expect(cell.className).toContain("text-red-700");
  });

  it("explains the empty state rather than showing a bare empty table", () => {
    render({ rows: [] });

    expect(screen.getByText(/AHPs and locums are not shown/)).toBeInTheDocument();
  });

  it("shows loading and error states", () => {
    const { unmount } = render({ isLoading: true });
    expect(screen.getByText("Loading...")).toBeInTheDocument();
    unmount();

    render({ isError: true });
    expect(screen.getByText("Could not load leave entitlement.")).toBeInTheDocument();
  });

  describe("year control", () => {
    it("renders the year and steps it in both directions", async () => {
      const user = userEvent.setup();
      const onPrevYear = vi.fn();
      const onNextYear = vi.fn();
      render({ onPrevYear, onNextYear });

      expect(screen.getByText("2026")).toBeInTheDocument();
      await user.click(screen.getByLabelText("Previous leave year"));
      await user.click(screen.getByLabelText("Next leave year"));

      expect(onPrevYear).toHaveBeenCalledTimes(1);
      expect(onNextYear).toHaveBeenCalledTimes(1);
    });
  });

  describe("warnings", () => {
    it("flags a doctor whose template disagrees with their sessions per week", () => {
      render({
        rows: [
          makeLeaveEntitlement({ sessions_per_week: "6.0", template_sessions_per_week: 8, sessions_mismatch: true }),
        ],
      });

      expect(within(rowFor("AB")).getByText(/Template implies 8 sessions\/wk/)).toBeInTheDocument();
      expect(screen.getByText(/accrues and is spent in different units/)).toBeInTheDocument();
    });

    it("does not flag a mismatch when the two agree", () => {
      render({ rows: [makeLeaveEntitlement()] });

      expect(screen.queryByText(/Template implies/)).not.toBeInTheDocument();
      expect(screen.queryByText(/different units/)).not.toBeInTheDocument();
    });

    it("surfaces sessions booked with no template row distinctly", () => {
      // Not folded into a single "exempt" figure: this count is the only
      // signal that a doctor's master template was never populated, which
      // otherwise reads as a suspiciously low "used".
      render({
        rows: [
          makeLeaveEntitlement({
            booked_sessions: 12,
            used_sessions: 0,
            exempt_by_reason: { closed: 0, weekend: 0, no_template_row: 12, no_surgery: 0 },
          }),
        ],
      });

      expect(
        within(rowFor("AB")).getByText(/12 booked with no template row/),
      ).toBeInTheDocument();
      expect(screen.getByText(/artificially low "used" figure/)).toBeInTheDocument();
    });

    it("says nothing about template rows when every booked session charged", () => {
      render({ rows: [makeLeaveEntitlement({ booked_sessions: 4, used_sessions: 4 })] });

      expect(screen.queryByText(/no template row/)).not.toBeInTheDocument();
    });
  });

  describe("entitlement notes", () => {
    it("shows the rule figure alongside an override, so the override is visible as one", () => {
      render({
        rows: [
          makeLeaveEntitlement({
            rule_sessions: "36.0",
            override_sessions: "40.0",
            entitlement_sessions: "40.0",
          }),
        ],
      });

      expect(within(rowFor("AB")).getByText(/Entitlement overridden \(rule: 36\)/)).toBeInTheDocument();
    });

    it("shows carry-over and adjustment", () => {
      render({
        rows: [
          makeLeaveEntitlement({
            carry_over_sessions: "4.0",
            adjustment_sessions: "-2.0",
            entitlement_sessions: "38.0",
          }),
        ],
      });

      const row = within(rowFor("AB"));
      expect(row.getByText(/Carried over: 4/)).toBeInTheDocument();
      expect(row.getByText(/Adjustment: -2/)).toBeInTheDocument();
    });

    it("shows the pro-rata percentage for a part-year doctor", () => {
      render({
        rows: [
          makeLeaveEntitlement({
            pro_rata_fraction: "0.504",
            rule_sessions: "18.1",
            entitlement_sessions: "18.1",
            remaining_sessions: "18.1",
          }),
        ],
      });

      expect(within(rowFor("AB")).getByText(/Pro-rata: 50% of the year/)).toBeInTheDocument();
    });

    it("says nothing for a doctor on the plain rule figure", () => {
      render({ rows: [makeLeaveEntitlement()] });

      const row = within(rowFor("AB"));
      expect(row.queryByText(/overridden/)).not.toBeInTheDocument();
      expect(row.queryByText(/Carried over/)).not.toBeInTheDocument();
      expect(row.queryByText(/Pro-rata/)).not.toBeInTheDocument();
    });
  });
});
