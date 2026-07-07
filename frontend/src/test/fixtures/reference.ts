import type { ClinicType, Doctor, Room } from "@/api/types";

let doctorIdCounter = 1;

export function makeDoctor(overrides: Partial<Doctor> = {}): Doctor {
  return {
    id: doctorIdCounter++,
    code: "AB",
    doctor_type: "Partner",
    sessions_per_week: "10.0",
    active: true,
    ...overrides,
  };
}

let roomIdCounter = 1;

export function makeRoom(overrides: Partial<Room> = {}): Room {
  return {
    id: roomIdCounter++,
    code: "D1",
    room_type: "D",
    site: "SHC",
    ...overrides,
  };
}

let clinicTypeIdCounter = 1;

export function makeClinicType(overrides: Partial<ClinicType> = {}): ClinicType {
  return {
    id: clinicTypeIdCounter++,
    name: "Diabetic clinic",
    clinic_priority: 1000,
    is_enabled: true,
    room_required: true,
    category: null,
    schedules: [],
    doctor_eligibilities: [],
    room_eligibilities: [],
    ...overrides,
  };
}