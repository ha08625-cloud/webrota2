import { z } from "zod";

import type { ClinicType, ClinicTypeIn, Day, Period, RoomType } from "@/api/types";

const dayEnum = z.enum(["Monday", "Tuesday", "Wednesday", "Thursday", "Friday"]);
const periodEnum = z.enum(["AM", "PM"]);
const roomTypeEnum = z.enum(["D", "C", "W", "SR"]);

const scheduleSchema = z.object({
  day: dayEnum,
  period: periodEnum,
});

const doctorEligSchema = z.object({
  doctorId: z.number().int(),
  doctorPriority: z.number().int(),
});

/**
 * Client-only discriminant (kind), collapsed to the wire's room_id/
 * room_type pair in toWirePayload. Mirrors the two separate "Add
 * specific room" / "Add room type" buttons in the form - a row is
 * always unambiguously one or the other from the moment it's created,
 * so there's no representable state where both or neither are set (the
 * server's RoomEligIn XOR validator and DB check constraint exist for a
 * row built some other way, e.g. directly against the API - this form
 * structurally can't produce that state to begin with).
 */
const roomEligSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("room"), roomId: z.number().int() }),
  z.object({ kind: z.literal("roomType"), roomType: roomTypeEnum }),
]);

export const clinicTypeFormSchema = z.object({
  name: z.string().min(1, "Name is required"),
  isEnabled: z.boolean(),
  roomRequired: z.boolean(),
  /** Empty string means "no category" (null on the wire) - see toWirePayload. */
  category: z.string(),
  schedules: z.array(scheduleSchema),
  doctorEligibilities: z
    .array(doctorEligSchema)
    .refine((rows) => new Set(rows.map((r) => r.doctorId)).size === rows.length, {
      message: "Each doctor can only appear once",
    }),
  roomEligibilities: z.array(roomEligSchema).refine(
    (rows) => {
      const roomIds = rows.filter((r) => r.kind === "room").map((r) => r.roomId);
      const roomTypes = rows.filter((r) => r.kind === "roomType").map((r) => r.roomType);
      return new Set(roomIds).size === roomIds.length && new Set(roomTypes).size === roomTypes.length;
    },
    { message: "The same room or room type cannot be added twice" },
  ),
});

export type ClinicTypeFormValues = z.infer<typeof clinicTypeFormSchema>;

export function emptyFormValues(): ClinicTypeFormValues {
  return {
    name: "",
    isEnabled: true,
    roomRequired: false,
    category: "",
    schedules: [],
    doctorEligibilities: [],
    roomEligibilities: [],
  };
}

/**
 * Builds initial form state from an existing ClinicType (edit mode).
 * Every child row round-trips, including eligibility rows for doctors
 * who have since been deactivated - the add-doctor select is filtered to
 * active doctors, but existing rows are preserved untouched here and by
 * toWirePayload, since PUT's replace-children pattern means anything
 * dropped from the submitted payload is permanently deleted, not merely
 * hidden from this session.
 */
export function formValuesFromClinicType(clinicType: ClinicType): ClinicTypeFormValues {
  return {
    name: clinicType.name,
    isEnabled: clinicType.is_enabled,
    roomRequired: clinicType.room_required,
    category: clinicType.category ?? "",
    schedules: clinicType.schedules.map((s) => ({ day: s.day as Day, period: s.period as Period })),
    doctorEligibilities: clinicType.doctor_eligibilities.map((d) => ({
      doctorId: d.doctor_id,
      doctorPriority: d.doctor_priority,
    })),
    roomEligibilities: clinicType.room_eligibilities.map((r) =>
      r.room_id !== null
        ? { kind: "room" as const, roomId: r.room_id }
        : { kind: "roomType" as const, roomType: r.room_type as RoomType },
    ),
  };
}

export function toWirePayload(values: ClinicTypeFormValues): ClinicTypeIn {
  return {
    name: values.name,
    is_enabled: values.isEnabled,
    room_required: values.roomRequired,
    category: values.category.trim() === "" ? null : values.category,
    schedules: values.schedules,
    doctor_eligibilities: values.doctorEligibilities.map((d) => ({
      doctor_id: d.doctorId,
      doctor_priority: d.doctorPriority,
    })),
    room_eligibilities: values.roomEligibilities.map((r) =>
      r.kind === "room" ? { room_id: r.roomId, room_type: null } : { room_id: null, room_type: r.roomType },
    ),
  };
}

/** Maps Zod's client-side validation issues onto top-level form field keys, for display next to each field. */
export function mapZodFieldErrors(error: z.ZodError): Record<string, string> {
  const fieldErrors: Record<string, string> = {};
  for (const issue of error.issues) {
    const key = issue.path[0];
    if (typeof key === "string" && !(key in fieldErrors)) {
      fieldErrors[key] = issue.message;
    }
  }
  return fieldErrors;
}
