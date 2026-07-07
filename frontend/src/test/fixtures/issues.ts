import type { ValidationIssue } from "@/api/types";

export function makeValidationIssue(overrides: Partial<ValidationIssue> = {}): ValidationIssue {
  return {
    severity: "warning",
    phase: "phase12",
    check: "role_on_incompatible_slot",
    message: "Duty assigned on a NO_SURGERY slot",
    week: 1,
    day: "Monday",
    period: "AM",
    ...overrides,
  };
}