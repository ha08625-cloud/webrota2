import { describe, expect, it } from "vitest";

import type { Doctor } from "@/api/types";

import { computeWeightedScore, formatOpeningBalance, formatWeightedScore } from "./weightedScore";

function makeDoctor(overrides: Partial<Doctor> = {}): Doctor {
  return {
    id: 1, code: "AB", doctor_type: "Partner", sessions_per_week: "10.0", active: true,
    supervision_preference: "normal", start_date: null, end_date: null, ...overrides,
  };
}

describe("computeWeightedScore", () => {
  it("divides raw_count by sessions_per_week and scales by 10, parsing the wire's Decimal string", () => {
    const result = computeWeightedScore(5, makeDoctor({ sessions_per_week: "10.0" }), "0.0");
    expect(result).toEqual({ kind: "value", value: 5 });
  });

  it("treats sessions_per_week === 0 as infinite, matching weighted_clinic_score/weighted_system_score in datatypes.py, not as missing data", () => {
    const result = computeWeightedScore(3, makeDoctor({ sessions_per_week: "0" }), "0.0");
    expect(result).toEqual({ kind: "infinite" });
  });

  it("treats sessions_per_week === '0.0' (the actual wire format) as infinite too", () => {
    const result = computeWeightedScore(3, makeDoctor({ sessions_per_week: "0.0" }), "0.0");
    expect(result).toEqual({ kind: "infinite" });
  });

  it("adds the opening balance to the raw count before dividing", () => {
    // The property the whole feature rests on: a joiner credited with the
    // group's score x their sessions (0.8 * 4 = 3.2) lands exactly on the
    // group's score rather than at zero.
    const result = computeWeightedScore(0, makeDoctor({ sessions_per_week: "4.0" }), "3.2");
    expect(result).toEqual({ kind: "value", value: 8 });
  });

  it("parses the balance rather than concatenating it onto the raw count", () => {
    // "1" + "3.2" would be 13.2 sessions, i.e. a score of 33 rather than 10.5.
    const result = computeWeightedScore(1, makeDoctor({ sessions_per_week: "4.0" }), "3.2");
    expect(result).toEqual({ kind: "value", value: 10.5 });
  });

  it("accepts a negative balance (a returner, or a leaver treated as already served)", () => {
    const result = computeWeightedScore(6, makeDoctor({ sessions_per_week: "4.0" }), "-2.0");
    expect(result).toEqual({ kind: "value", value: 10 });
  });

  it("treats an unparseable balance as no credit rather than rendering NaN", () => {
    const result = computeWeightedScore(4, makeDoctor({ sessions_per_week: "8.0" }), "");
    expect(result).toEqual({ kind: "value", value: 5 });
  });

  it("returns unknown, not a crash, when the doctor is missing (a failed join)", () => {
    expect(computeWeightedScore(5, undefined, "0.0")).toEqual({ kind: "unknown" });
  });
});

describe("formatWeightedScore", () => {
  it("formats a value to two decimal places", () => {
    expect(formatWeightedScore({ kind: "value", value: 5 })).toBe("5.00");
    expect(formatWeightedScore({ kind: "value", value: 10 / 3 })).toBe("3.33");
  });

  it("honours an explicit decimals argument (the duty grid asks for 1dp)", () => {
    expect(formatWeightedScore({ kind: "value", value: 5 }, 1)).toBe("5.0");
    expect(formatWeightedScore({ kind: "value", value: 10 / 3 }, 1)).toBe("3.3");
  });

  it("formats infinite as the infinity symbol, not a dash", () => {
    expect(formatWeightedScore({ kind: "infinite" })).toBe("\u221e");
  });

  it("formats unknown as a dash", () => {
    expect(formatWeightedScore({ kind: "unknown" })).toBe("-");
  });
});
describe("formatOpeningBalance", () => {
  it("returns null for a zero balance, so rows with no credit are unmarked", () => {
    expect(formatOpeningBalance("0.0")).toBeNull();
    expect(formatOpeningBalance("0")).toBeNull();
  });

  it("signs the credit explicitly, to one decimal place", () => {
    expect(formatOpeningBalance("3.2")).toBe("+3.2");
    expect(formatOpeningBalance("4")).toBe("+4.0");
  });

  it("formats a negative balance with a minus sign", () => {
    expect(formatOpeningBalance("-2.5")).toBe("-2.5");
  });
});
