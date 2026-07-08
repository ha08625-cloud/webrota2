import type { ClinicType, Doctor, DoctorDetail, DutyAssignment, LeaveEntry, Room } from "@/api/types";

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

export function makeDoctorDetail(overrides: Partial<DoctorDetail> = {}): DoctorDetail {
  const { preferred_rooms, ...doctorOverrides } = overrides;
  return {
    ...makeDoctor(doctorOverrides),
    preferred_rooms: preferred_rooms ?? [],
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

let leaveIdCounter = 1;

export function makeLeaveEntry(overrides: Partial<LeaveEntry> = {}): LeaveEntry {
  return {
    id: leaveIdCounter++,
    doctor_id: 1,
    date: "2026-08-03",
    period: "AM",
    ...overrides,
  };
}

let dutyIdCounter = 1;

export function makeDutyAssignment(overrides: Partial<DutyAssignment> = {}): DutyAssignment {
  return {
    id: dutyIdCounter++,
    date: "2026-08-03",
    period: "AM",
    doctor_id: 1,
    duty_type: "primary",
    ...overrides,
  };
}