import { describe, expect, it } from "vitest";

import type { Doctor } from "@/api/types";

import { computeWeightedScore, formatWeightedScore } from "./weightedScore";

function makeDoctor(overrides: Partial<Doctor> = {}): Doctor {
  return {
    id: 1, code: "AB", doctor_type: "Partner", sessions_per_week: "10.0", active: true,
    supervision_preference: "normal", start_date: null, end_date: null, ...overrides,
  };
}

describe("computeWeightedScore", () => {
  it("divides raw_count by sessions_per_week and scales by 10, parsing the wire's Decimal string", () => {
    const result = computeWeightedScore(5, makeDoctor({ sessions_per_week: "10.0" }));
    expect(result).toEqual({ kind: "value", value: 5 });
  });

  it("treats sessions_per_week === 0 as infinite, matching weighted_clinic_score/weighted_system_score in datatypes.py, not as missing data", () => {
    const result = computeWeightedScore(3, makeDoctor({ sessions_per_week: "0" }));
    expect(result).toEqual({ kind: "infinite" });
  });

  it("treats sessions_per_week === '0.0' (the actual wire format) as infinite too", () => {
    const result = computeWeightedScore(3, makeDoctor({ sessions_per_week: "0.0" }));
    expect(result).toEqual({ kind: "infinite" });
  });

  it("returns unknown, not a crash, when the doctor is missing (a failed join)", () => {
    expect(computeWeightedScore(5, undefined)).toEqual({ kind: "unknown" });
  });
});

describe("formatWeightedScore", () => {
  it("formats a value to two decimal places", () => {
    expect(formatWeightedScore({ kind: "value", value: 5 })).toBe("5.00");
    expect(formatWeightedScore({ kind: "value", value: 10 / 3 })).toBe("3.33");
  });

  it("formats infinite as the infinity symbol, not a dash", () => {
    expect(formatWeightedScore({ kind: "infinite" })).toBe("\u221e");
  });

  it("formats unknown as a dash", () => {
    expect(formatWeightedScore({ kind: "unknown" })).toBe("-");
  });
});