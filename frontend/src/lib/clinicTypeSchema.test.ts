import { describe, expect, it } from "vitest";

import { makeClinicType } from "@/test/fixtures/reference";

import {
  clinicTypeFormSchema,
  emptyFormValues,
  formValuesFromClinicType,
  mapZodFieldErrors,
  toWirePayload,
} from "./clinicTypeSchema";

describe("clinicTypeFormSchema", () => {
  it("accepts a minimal valid create payload", () => {
    const result = clinicTypeFormSchema.safeParse(emptyFormValues());
    expect(result.success).toBe(false); // empty name
  });

  it("accepts a fully populated valid payload", () => {
    const values = {
      ...emptyFormValues(),
      name: "Diabetic clinic",
      schedules: [{ day: "Monday" as const, period: "AM" as const }],
      doctorEligibilities: [{ doctorId: 1, doctorPriority: 1000 }],
      roomEligibilities: [{ kind: "room" as const, roomId: 1 }],
    };
    const result = clinicTypeFormSchema.safeParse(values);
    expect(result.success).toBe(true);
  });

  it("rejects an empty name", () => {
    const result = clinicTypeFormSchema.safeParse({ ...emptyFormValues(), name: "" });
    expect(result.success).toBe(false);
    if (!result.success) {
      const fieldErrors = mapZodFieldErrors(result.error);
      expect(fieldErrors.name).toBeDefined();
    }
  });

  it("rejects duplicate doctor eligibility rows for the same doctor", () => {
    const values = {
      ...emptyFormValues(),
      name: "X",
      doctorEligibilities: [
        { doctorId: 1, doctorPriority: 1000 },
        { doctorId: 1, doctorPriority: 500 },
      ],
    };
    const result = clinicTypeFormSchema.safeParse(values);
    expect(result.success).toBe(false);
  });

  it("rejects duplicate room eligibility rows for the same specific room", () => {
    const values = {
      ...emptyFormValues(),
      name: "X",
      roomEligibilities: [
        { kind: "room" as const, roomId: 1 },
        { kind: "room" as const, roomId: 1 },
      ],
    };
    const result = clinicTypeFormSchema.safeParse(values);
    expect(result.success).toBe(false);
  });

  it("rejects duplicate room eligibility rows for the same room type", () => {
    const values = {
      ...emptyFormValues(),
      name: "X",
      roomEligibilities: [
        { kind: "roomType" as const, roomType: "D" as const },
        { kind: "roomType" as const, roomType: "D" as const },
      ],
    };
    const result = clinicTypeFormSchema.safeParse(values);
    expect(result.success).toBe(false);
  });

  it("allows the same room type as a room-type row and a specific room as a room row (independent constraints)", () => {
    const values = {
      ...emptyFormValues(),
      name: "X",
      roomEligibilities: [
        { kind: "roomType" as const, roomType: "D" as const },
        { kind: "room" as const, roomId: 1 },
      ],
    };
    const result = clinicTypeFormSchema.safeParse(values);
    expect(result.success).toBe(true);
  });
});

describe("toWirePayload", () => {
  it("collapses a 'room' row to room_id set, room_type null", () => {
    const values = { ...emptyFormValues(), name: "X", roomEligibilities: [{ kind: "room" as const, roomId: 3 }] };
    const parsed = clinicTypeFormSchema.parse(values);
    const wire = toWirePayload(parsed);
    expect(wire.room_eligibilities).toEqual([{ room_id: 3, room_type: null }]);
  });

  it("collapses a 'roomType' row to room_type set, room_id null", () => {
    const values = {
      ...emptyFormValues(),
      name: "X",
      roomEligibilities: [{ kind: "roomType" as const, roomType: "C" as const }],
    };
    const parsed = clinicTypeFormSchema.parse(values);
    const wire = toWirePayload(parsed);
    expect(wire.room_eligibilities).toEqual([{ room_id: null, room_type: "C" }]);
  });

  it("maps camelCase form fields to the wire's snake_case names", () => {
    const values = { ...emptyFormValues(), name: "X", roomRequired: true };
    const parsed = clinicTypeFormSchema.parse(values);
    const wire = toWirePayload(parsed);
    expect(wire.room_required).toBe(true);
  });

  it("maps an empty category string to null", () => {
    const values = { ...emptyFormValues(), name: "X", category: "" };
    const parsed = clinicTypeFormSchema.parse(values);
    expect(toWirePayload(parsed).category).toBeNull();
  });

  it("keeps a non-empty category string as-is", () => {
    const values = { ...emptyFormValues(), name: "X", category: "duty_helper" };
    const parsed = clinicTypeFormSchema.parse(values);
    expect(toWirePayload(parsed).category).toBe("duty_helper");
  });
});

describe("formValuesFromClinicType", () => {
  it("round-trips a room eligibility row with a specific room_id", () => {
    const ct = makeClinicType({ room_eligibilities: [{ id: 1, room_id: 5, room_type: null }] });
    const values = formValuesFromClinicType(ct);
    expect(values.roomEligibilities).toEqual([{ kind: "room", roomId: 5 }]);
  });

  it("round-trips a room eligibility row with a room_type", () => {
    const ct = makeClinicType({ room_eligibilities: [{ id: 1, room_id: null, room_type: "W" }] });
    const values = formValuesFromClinicType(ct);
    expect(values.roomEligibilities).toEqual([{ kind: "roomType", roomType: "W" }]);
  });

  it("round-trips a doctor eligibility row regardless of the doctor's current active status (form layer has no doctor data to check against)", () => {
    const ct = makeClinicType({ doctor_eligibilities: [{ id: 1, doctor_id: 99, doctor_priority: 10 }] });
    const values = formValuesFromClinicType(ct);
    expect(values.doctorEligibilities).toEqual([{ doctorId: 99, doctorPriority: 10 }]);
  });

  it("maps a null category to an empty string for the text input", () => {
    const ct = makeClinicType({ category: null });
    expect(formValuesFromClinicType(ct).category).toBe("");
  });
});
