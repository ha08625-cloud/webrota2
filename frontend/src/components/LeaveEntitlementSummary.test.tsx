import { screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { makeLeaveEntitlement } from "@/test/fixtures/reference";
import { renderWithProviders } from "@/test/renderWithProviders";

import { LeaveEntitlementSummary } from "./LeaveEntitlementSummary";

function render(props: Partial<Parameters<typeof LeaveEntitlementSummary>[0]> = {}) {
  return renderWithProviders(
    <LeaveEntitlementSummary
      year={props.year ?? 2026}
      row={props.row ?? null}
      isLoading={props.isLoading}
      isError={props.isError}
    />,
  );
}

describe("LeaveEntitlementSummary", () => {
  it("states used out of entitlement as a fraction", () => {
    render({
      row: makeLeaveEntitlement({
        used_sessions: 7,
        entitlement_sessions: "49.0",
        remaining_sessions: "42.0",
      }),
    });

    expect(screen.getByTestId("leave-fraction-AB")).toHaveTextContent("7/49");
    expect(screen.getByText(/42 remaining/)).toBeInTheDocument();
    expect(screen.getByText("Leave 2026:")).toBeInTheDocument();
  });

  it("drops a trailing .0 but keeps a real fraction", () => {
    render({
      row: makeLeaveEntitlement({ used_sessions: 2, entitlement_sessions: "18.1" }),
    });

    expect(screen.getByTestId("leave-fraction-AB")).toHaveTextContent("2/18.1");
  });

  it("marks an over-booked doctor in red", () => {
    render({
      row: makeLeaveEntitlement({ used_sessions: 40, remaining_sessions: "-4.0" }),
    });

    expect(screen.getByTestId("leave-fraction-AB").className).toContain("text-red-700");
  });

  it("renders nothing for a doctor with no entitlement row", () => {
    render({ row: null });

    expect(screen.queryByTestId("leave-entitlement")).not.toBeInTheDocument();
  });

  it("shows loading and error states", () => {
    const { unmount } = render({ isLoading: true });
    expect(screen.getByText("Loading leave entitlement...")).toBeInTheDocument();
    unmount();

    render({ isError: true });
    expect(screen.getByText("Could not load leave entitlement.")).toBeInTheDocument();
  });

  describe("warnings", () => {
    it("surfaces sessions booked with no template row", () => {
      // The only signal that a doctor's master template was never
      // populated, which otherwise reads as a suspiciously low "used".
      render({
        row: makeLeaveEntitlement({
          booked_sessions: 12,
          used_sessions: 0,
          exempt_by_reason: { closed: 0, weekend: 0, no_template_row: 12, no_surgery: 0 },
        }),
      });

      expect(screen.getByText(/12 sessions booked against slots with no master/)).toBeInTheDocument();
    });

    it("says nothing about template rows when every booked session charged", () => {
      render({ row: makeLeaveEntitlement({ booked_sessions: 4, used_sessions: 4 }) });

      expect(screen.queryByText(/no master template row/)).not.toBeInTheDocument();
    });

    it("leaves the sessions mismatch to the staff tab", () => {
      render({
        row: makeLeaveEntitlement({
          sessions_per_week: "6.0",
          template_sessions_per_week: 8,
          sessions_mismatch: true,
        }),
      });

      expect(screen.queryByText(/Template implies/)).not.toBeInTheDocument();
    });
  });

  describe("entitlement notes", () => {
    it("shows the rule figure alongside an override, so the override is visible as one", () => {
      render({
        row: makeLeaveEntitlement({
          rule_sessions: "36.0",
          override_sessions: "40.0",
          entitlement_sessions: "40.0",
        }),
      });

      expect(screen.getByText(/Entitlement overridden \(rule: 36\)/)).toBeInTheDocument();
    });

    it("shows carry-over and adjustment", () => {
      render({
        row: makeLeaveEntitlement({
          carry_over_sessions: "4.0",
          adjustment_sessions: "-2.0",
          entitlement_sessions: "38.0",
        }),
      });

      expect(screen.getByText(/Carried over: 4/)).toBeInTheDocument();
      expect(screen.getByText(/Adjustment: -2/)).toBeInTheDocument();
    });

    it("shows the pro-rata percentage for a part-year doctor", () => {
      render({
        row: makeLeaveEntitlement({
          pro_rata_fraction: "0.504",
          rule_sessions: "18.1",
          entitlement_sessions: "18.1",
          remaining_sessions: "18.1",
        }),
      });

      expect(screen.getByText(/Pro-rata: 50% of the year/)).toBeInTheDocument();
    });

    it("says nothing for a doctor on the plain rule figure", () => {
      render({ row: makeLeaveEntitlement() });

      expect(screen.queryByText(/overridden/)).not.toBeInTheDocument();
      expect(screen.queryByText(/Carried over/)).not.toBeInTheDocument();
      expect(screen.queryByText(/Pro-rata/)).not.toBeInTheDocument();
    });
  });
});
