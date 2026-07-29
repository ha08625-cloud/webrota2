import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import type { ValidationIssue } from "@/api/types";
import { ReceptionCoveragePanel } from "./ReceptionCoveragePanel";

function makeIssue(overrides: Partial<ValidationIssue> = {}): ValidationIssue {
  return {
    severity: "warning",
    phase: "coverage",
    check: "phones_shortfall",
    message: "09:00-10:00: 2 staff on phones, 3 required",
    week: null,
    day: "Monday",
    period: null,
    ...overrides,
  };
}

describe("ReceptionCoveragePanel", () => {
  it("shows a no-shortfalls message when there are no issues", () => {
    render(<ReceptionCoveragePanel issues={[]} />);
    expect(screen.getByText("No coverage shortfalls.")).toBeInTheDocument();
  });

  it("lists each issue's message", () => {
    const issues = [
      makeIssue({ message: "09:00-10:00: 2 staff on phones, 3 required" }),
      makeIssue({ message: "14:00-15:00: 1 staff on phones, 2 required" }),
    ];
    render(<ReceptionCoveragePanel issues={issues} />);

    expect(screen.getByText("09:00-10:00: 2 staff on phones, 3 required")).toBeInTheDocument();
    expect(screen.getByText("14:00-15:00: 1 staff on phones, 2 required")).toBeInTheDocument();
  });

  it("reads as a warning, not an error", () => {
    render(<ReceptionCoveragePanel issues={[makeIssue()]} />);
    expect(screen.queryByText(/error/i)).not.toBeInTheDocument();
    const item = screen.getByText("09:00-10:00: 2 staff on phones, 3 required");
    expect(item.className).toContain("amber");
    expect(item.className).not.toContain("red");
  });
});
