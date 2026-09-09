import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { makeLeaveEntry } from "@/test/fixtures/reference";

import { LeaveRangePreview } from "./LeaveRangePreview";

describe("LeaveRangePreview", () => {
  it("renders one month grid per calendar month the range touches", () => {
    render(
      <LeaveRangePreview
        mode="add"
        startDate="2026-07-30"
        endDate="2026-08-03"
        segments={[{ start_date: "2026-07-30", end_date: "2026-08-03", period: "BOTH" }]}
        existingEntries={[]}
      />,
    );

    expect(screen.getByText("July 2026")).toBeInTheDocument();
    expect(screen.getByText("August 2026")).toBeInTheDocument();
  });

  it("falls back to text when the range spans more than 4 months", () => {
    render(
      <LeaveRangePreview
        mode="add"
        startDate="2026-01-05"
        endDate="2026-06-05"
        segments={[{ start_date: "2026-01-05", end_date: "2026-06-05", period: "BOTH" }]}
        existingEntries={[]}
      />,
    );

    expect(screen.getByText("Range spans 6 months - preview not shown.")).toBeInTheDocument();
    expect(screen.queryByTestId("leave-range-preview")).not.toBeInTheDocument();
  });

  it("does not render weekend cells", () => {
    render(
      <LeaveRangePreview
        mode="add"
        startDate="2026-07-13"
        endDate="2026-07-20"
        segments={[{ start_date: "2026-07-13", end_date: "2026-07-20", period: "BOTH" }]}
        existingEntries={[]}
      />,
    );

    // 2026-07-18 is a Saturday inside the range.
    expect(screen.queryByTestId("preview-2026-07-18-AM")).not.toBeInTheDocument();
    expect(screen.getByTestId("preview-2026-07-17-AM")).toBeInTheDocument();
    expect(screen.getByTestId("preview-2026-07-20-AM")).toBeInTheDocument();
  });

  it("add mode: marks planned-and-new as add, planned-and-existing as duplicate, and other existing leave as existing", () => {
    render(
      <LeaveRangePreview
        mode="add"
        startDate="2026-07-13"
        endDate="2026-07-14"
        segments={[{ start_date: "2026-07-13", end_date: "2026-07-14", period: "BOTH" }]}
        existingEntries={[
          makeLeaveEntry({ doctor_id: 1, date: "2026-07-13", period: "AM" }),
          makeLeaveEntry({ doctor_id: 1, date: "2026-07-20", period: "AM" }),
        ]}
      />,
    );

    expect(screen.getByTestId("preview-2026-07-13-AM")).toHaveAttribute("data-state", "duplicate");
    expect(screen.getByTestId("preview-2026-07-13-PM")).toHaveAttribute("data-state", "add");
    expect(screen.getByTestId("preview-2026-07-14-AM")).toHaveAttribute("data-state", "add");
    // Same rendered month, outside the planned segments.
    expect(screen.getByTestId("preview-2026-07-20-AM")).toHaveAttribute("data-state", "existing");
    expect(screen.getByTestId("preview-2026-07-20-PM")).toHaveAttribute("data-state", "none");
  });

  it("remove mode: marks planned-and-existing as remove and untouched entries as existing", () => {
    render(
      <LeaveRangePreview
        mode="remove"
        startDate="2026-07-13"
        endDate="2026-07-13"
        segments={[{ start_date: "2026-07-13", end_date: "2026-07-13", period: "BOTH" }]}
        existingEntries={[
          makeLeaveEntry({ doctor_id: 1, date: "2026-07-13", period: "AM" }),
          makeLeaveEntry({ doctor_id: 1, date: "2026-07-14", period: "PM" }),
        ]}
      />,
    );

    expect(screen.getByTestId("preview-2026-07-13-AM")).toHaveAttribute("data-state", "remove");
    // Planned but nothing exists there - nothing to remove.
    expect(screen.getByTestId("preview-2026-07-13-PM")).toHaveAttribute("data-state", "none");
    expect(screen.getByTestId("preview-2026-07-14-PM")).toHaveAttribute("data-state", "existing");
  });

  it("half-day edge segments colour only the affected halves", () => {
    render(
      <LeaveRangePreview
        mode="add"
        startDate="2026-07-13"
        endDate="2026-07-15"
        segments={[
          { start_date: "2026-07-13", end_date: "2026-07-13", period: "PM" },
          { start_date: "2026-07-14", end_date: "2026-07-14", period: "BOTH" },
          { start_date: "2026-07-15", end_date: "2026-07-15", period: "AM" },
        ]}
        existingEntries={[]}
      />,
    );

    expect(screen.getByTestId("preview-2026-07-13-AM")).toHaveAttribute("data-state", "none");
    expect(screen.getByTestId("preview-2026-07-13-PM")).toHaveAttribute("data-state", "add");
    expect(screen.getByTestId("preview-2026-07-14-AM")).toHaveAttribute("data-state", "add");
    expect(screen.getByTestId("preview-2026-07-15-AM")).toHaveAttribute("data-state", "add");
    expect(screen.getByTestId("preview-2026-07-15-PM")).toHaveAttribute("data-state", "none");
  });

  it("shows the legend for the current mode only", () => {
    const { rerender } = render(
      <LeaveRangePreview
        mode="add"
        startDate="2026-07-13"
        endDate="2026-07-13"
        segments={[{ start_date: "2026-07-13", end_date: "2026-07-13", period: "BOTH" }]}
        existingEntries={[]}
      />,
    );

    const preview = screen.getByTestId("leave-range-preview");
    expect(within(preview).getByText("Will be added")).toBeInTheDocument();
    expect(within(preview).queryByText("Will be removed")).not.toBeInTheDocument();

    rerender(
      <LeaveRangePreview
        mode="remove"
        startDate="2026-07-13"
        endDate="2026-07-13"
        segments={[{ start_date: "2026-07-13", end_date: "2026-07-13", period: "BOTH" }]}
        existingEntries={[]}
      />,
    );

    expect(within(preview).getByText("Will be removed")).toBeInTheDocument();
    expect(within(preview).queryByText("Will be added")).not.toBeInTheDocument();
  });
});