import { describe, expect, it } from "vitest";

import { makeDutyAssignment } from "@/test/fixtures/reference";

import { resolveDutyDrop } from "./resolveDutyDrop";

describe("resolveDutyDrop", () => {
  it("returns null when there is no dragged doctor", () => {
    const over = { date: "2026-08-03", period: "AM" as const, dutyType: "primary" as const, assignment: null };
    expect(resolveDutyDrop(undefined, over)).toBeNull();
  });

  it("returns null when there is no drop target", () => {
    const active = { doctorId: 1, doctorCode: "AB" };
    expect(resolveDutyDrop(active, undefined)).toBeNull();
  });

  it("returns null for dropping a doctor back onto the slot they already occupy", () => {
    const assignment = makeDutyAssignment({ id: 1, doctor_id: 1, date: "2026-08-03", period: "AM", duty_type: "primary" });
    const active = { doctorId: 1, doctorCode: "AB" };
    const over = { date: "2026-08-03", period: "AM" as const, dutyType: "primary" as const, assignment };
    expect(resolveDutyDrop(active, over)).toBeNull();
  });

  it("returns a create-only outcome for a drop onto an empty slot", () => {
    const active = { doctorId: 2, doctorCode: "CD" };
    const over = { date: "2026-08-04", period: "PM" as const, dutyType: "primary" as const, assignment: null };

    const outcome = resolveDutyDrop(active, over);

    expect(outcome).toEqual({
      doctorId: 2,
      date: "2026-08-04",
      period: "PM",
      dutyType: "primary",
      existingAssignmentId: null,
    });
  });

  it("returns a replace outcome, carrying the existing assignment id, for a drop onto an occupied slot with a different doctor", () => {
    const assignment = makeDutyAssignment({ id: 7, doctor_id: 1, date: "2026-08-03", period: "AM", duty_type: "secondary" });
    const active = { doctorId: 2, doctorCode: "CD" };
    const over = { date: "2026-08-03", period: "AM" as const, dutyType: "secondary" as const, assignment };

    const outcome = resolveDutyDrop(active, over);

    expect(outcome).toEqual({
      doctorId: 2,
      date: "2026-08-03",
      period: "AM",
      dutyType: "secondary",
      existingAssignmentId: 7,
    });
  });
});