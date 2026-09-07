import type {
  AuthUser,
  BlockedEntry,
  ClinicCounter,
  ClinicType,
  Closure,
  Doctor,
  DoctorDetail,
  DutyAssignment,
  ExtraSessionEntry,
  LeaveEntitlement,
  LeaveEntry,
  RecurringNote,
  Room,
  School,
  SchoolHoliday,
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
    // Unbounded employment window - the state every doctor is in until
    // one is set (annual leave planning, Task 1).
    start_date: null,
    end_date: null,
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

/**
 * A doctor's leave balance row. Defaults are a salaried doctor working 6
 * sessions a week with nothing booked: 6 x 6 = 36 sessions, all remaining,
 * template in agreement so no warning renders. Override
 * `template_sessions_per_week`/`sessions_mismatch` together - the fixture
 * does not derive one from the other, because tests need to be able to
 * build the inconsistent combinations the server would never send.
 */
export function makeLeaveEntitlement(
  overrides: Partial<LeaveEntitlement> = {},
): LeaveEntitlement {
  return {
    doctor_id: 1,
    doctor_code: "AB",
    doctor_type: "Salaried",
    year: 2026,
    sessions_per_week: "6.0",
    weeks: "6",
    full_year_sessions: "36.0",
    pro_rata_fraction: "1.000",
    rule_sessions: "36.0",
    override_sessions: null,
    carry_over_sessions: "0.0",
    adjustment_sessions: "0.0",
    entitlement_sessions: "36.0",
    used_sessions: 0,
    booked_sessions: 0,
    exempt_by_reason: { closed: 0, weekend: 0, no_template_row: 0, no_surgery: 0 },
    remaining_sessions: "36.0",
    template_sessions_per_week: 6,
    sessions_mismatch: false,
    notes: null,
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

let blockedIdCounter = 1;

export function makeBlockedEntry(overrides: Partial<BlockedEntry> = {}): BlockedEntry {
  return {
    id: blockedIdCounter++,
    doctor_id: 1,
    date: "2026-08-03",
    period: "AM",
    notes: null,
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
    period: "AM",
    name: "Easter Monday",
    ...overrides,
  };
}

/** A full-day closure: two rows sharing a date - there is no
 * "full day" special case in the data model. */
export function makeFullDayClosure(overrides: Partial<Omit<Closure, "id" | "period">> = {}): Closure[] {
  return [
    makeClosure({ ...overrides, period: "AM" }),
    makeClosure({ ...overrides, period: "PM" }),
  ];
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

let recurringNoteIdCounter = 1;

export function makeRecurringNote(overrides: Partial<RecurringNote> = {}): RecurringNote {
  return {
    id: recurringNoteIdCounter++,
    text: "Partners meeting",
    day: "Monday",
    period: "PM",
    is_active: true,
    doctor_ids: [1],
    template_weeks: [1, 2, 3, 4],
    ...overrides,
  };
}

let schoolHolidayIdCounter = 1;

export function makeSchoolHoliday(overrides: Partial<SchoolHoliday> = {}): SchoolHoliday {
  return {
    id: schoolHolidayIdCounter++,
    school_id: 1,
    start_date: "2026-07-21",
    end_date: "2026-08-31",
    name: "Summer holidays",
    ...overrides,
  };
}

let schoolIdCounter = 1;

export function makeSchool(overrides: Partial<School> = {}): School {
  return {
    id: schoolIdCounter++,
    name: "St Mary's Primary",
    holidays: [],
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
    // Manager by default so fixtures keep exercising the full UI; tests
    // about a lower tier pass an override (role-based auth, Task 3).
    access_level: "manager",
    // Everything granted, for the same reason and ahead of anything
    // reading it: when the UI moves off access_level, a fixture user
    // should still see the whole app unless a test says otherwise
    // (fine-grained permissions, Task 1).
    permissions: {
      clinical: "write",
      reception: "write",
      signatures: true,
      study_eoi: true,
      user_admin: true,
    },
    // Unlinked by default: the link is opt-in, and a test that cares
    // about "my rota" supplies one via overrides.
    linked_doctor: null,
    linked_reception_staff: null,
    created_at: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}