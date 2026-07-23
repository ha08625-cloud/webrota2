import type {
  AuthUser,
  ClinicCounter,
  ClinicType,
  Closure,
  Doctor,
  DoctorDetail,
  DutyAssignment,
  ExtraSessionEntry,
  LeaveEntry,
  Room,
  SystemCounter,
} from "@/api/types";

let doctorIdCounter = 1;

export function makeDoctor(overrides: Partial<Doctor> = {}): Doctor {
  return {
    id: doctorIdCounter++,
    code: "AB",
    doctor_type: "Partner",
    sessions_per_week: "10.0",
    active: true,
    supervision_preference: "normal",
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

let extraSessionIdCounter = 1;

export function makeExtraSessionEntry(overrides: Partial<ExtraSessionEntry> = {}): ExtraSessionEntry {
  return {
    id: extraSessionIdCounter++,
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

let closureIdCounter = 1;

export function makeClosure(overrides: Partial<Closure> = {}): Closure {
  return {
    id: closureIdCounter++,
    date: "2026-04-06",
    name: "Easter Monday",
    ...overrides,
  };
}

let clinicCounterIdCounter = 1;

export function makeClinicCounter(overrides: Partial<ClinicCounter> = {}): ClinicCounter {
  return {
    id: clinicCounterIdCounter++,
    doctor_id: 1,
    doctor_code: "AB",
    clinic_type_id: 1,
    clinic_type_name: "Diabetic clinic",
    raw_count: 3,
    ...overrides,
  };
}

let systemCounterIdCounter = 1;

export function makeSystemCounter(overrides: Partial<SystemCounter> = {}): SystemCounter {
  return {
    id: systemCounterIdCounter++,
    doctor_id: 1,
    doctor_code: "AB",
    counter_type: "room_move",
    raw_count: 2,
    ...overrides,
  };
}

let authUserIdCounter = 1;

export function makeAuthUser(overrides: Partial<AuthUser> = {}): AuthUser {
  return {
    id: authUserIdCounter++,
    email: "ann@example.com",
    name: "Ann",
    active: true,
    created_at: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}