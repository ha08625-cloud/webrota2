import { describe, expect, it } from "vitest";

import {
  computeReceptionWeightedScore,
  formatReceptionWeightedScore,
} from "./receptionWeightedScore";

describe("computeReceptionWeightedScore", () => {
  it("returns role hours as a proportion of hours worked, with no cosmetic scaling", () => {
    // 4 phones slots = 2.0h of a 10h window.
    expect(computeReceptionWeightedScore("phones", 4, 10)).toEqual({ kind: "value", value: 0.2 });
  });

  it("returns unknown - not infinite, unlike weightedScore.ts - when no hours were worked", () => {
    expect(computeReceptionWeightedScore("phones", 0, 0)).toEqual({ kind: "unknown" });
  });

  it("returns not-applicable for not_working, whose hours are outside the denominator", () => {
    // Would otherwise read as 500%: 1.0h of phones, 5.0h not working, 1.0h worked.
    expect(computeReceptionWeightedScore("not_working", 10, 1)).toEqual({ kind: "not-applicable" });
  });

  it("scores lunch like any other role, since lunch counts as working time", () => {
    expect(computeReceptionWeightedScore("lunch", 2, 10)).toEqual({ kind: "value", value: 0.1 });
  });

  it("returns 1 for a role that filled the whole window", () => {
    expect(computeReceptionWeightedScore("admin", 20, 10)).toEqual({ kind: "value", value: 1 });
  });
});

describe("formatReceptionWeightedScore", () => {
  it("renders a proportion as a whole-number percentage", () => {
    expect(formatReceptionWeightedScore({ kind: "value", value: 0.3125 })).toBe("31%");
  });

  it("renders zero as 0%, not as an em dash", () => {
    expect(formatReceptionWeightedScore({ kind: "value", value: 0 })).toBe("0%");
  });

  it("renders both no-score cases as an em dash", () => {
    expect(formatReceptionWeightedScore({ kind: "not-applicable" })).toBe("—");
    expect(formatReceptionWeightedScore({ kind: "unknown" })).toBe("—");
  });
});
