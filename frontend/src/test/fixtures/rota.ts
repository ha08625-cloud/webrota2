import type { GenerationLogEntry, Rota, RotaSession, RotaSummary } from "@/api/types";

export function makeRotaSummary(overrides: Partial<RotaSummary> = {}): RotaSummary {
  return {
    rota_id: 1,
    status: "draft",
    created_at: "2026-07-06T10:00:00Z",
    start_date: "2026-07-06",
    num_weeks: 2,
    template_start_week: 1,
    committed_at: null,
    ...overrides,
  };
}

export function makeRota(overrides: Partial<Rota> = {}): Rota {
  return {
    rota_id: 1,
    status: "draft",
    created_at: "2026-07-06T10:00:00Z",
    start_date: "2026-07-06",
    num_weeks: 2,
    template_start_week: 1,
    sessions: [],
    closed_dates: [],
    committed_at: null,
    ...overrides,
  };
}

let sessionIdCounter = 1;

export function makeRotaSession(overrides: Partial<RotaSession> = {}): RotaSession {
  return {
    session_id: sessionIdCounter++,
    doctor_id: 1,
    doctor_code: "AB",
    week: 1,
    day: "Monday",
    period: "AM",
    room_id: null,
    room_code: null,
    clinic_type_id: null,
    clinic_type_name: null,
    role: null,
    template_type: "requires_room",
    is_wfh: false,
    is_supervising: false,
    is_on_leave: false,
    notes: null,
    ...overrides,
  };
}

let logSequenceCounter = 0;

export function makeGenerationLogEntry(overrides: Partial<GenerationLogEntry> = {}): GenerationLogEntry {
  return {
    sequence: logSequenceCounter++,
    phase: "phase5",
    action: "assign_clinic",
    message: "Dr AA assigned to Diabetic clinic",
    week: 1,
    day: "Monday",
    period: "AM",
    doctor_id: 1,
    related_doctor_id: null,
    room_id: null,
    related_room_id: null,
    clinic_type_id: 1,
    ...overrides,
  };
}