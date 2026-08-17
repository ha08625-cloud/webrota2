import type {
  ReceptionLeaveEntry,
  ReceptionMasterSession,
  ReceptionRota,
  ReceptionRotaSession,
  ReceptionStaff,
} from "@/api/types";

let staffIdCounter = 1;

export function makeReceptionStaff(overrides: Partial<ReceptionStaff> = {}): ReceptionStaff {
  return {
    id: staffIdCounter++,
    code: "JS",
    name: "Jo Smith",
    active: true,
    ...overrides,
  };
}

let masterSessionIdCounter = 1;

export function makeReceptionMasterSession(
  overrides: Partial<ReceptionMasterSession> = {},
): ReceptionMasterSession {
  return {
    session_id: masterSessionIdCounter++,
    staff_id: 1,
    staff_code: "JS",
    staff_name: "Jo Smith",
    day: "Monday",
    hour: 9,
    role: "phones",
    note: null,
    ...overrides,
  };
}

let rotaSessionIdCounter = 1;

export function makeReceptionRotaSession(
  overrides: Partial<ReceptionRotaSession> = {},
): ReceptionRotaSession {
  return {
    session_id: rotaSessionIdCounter++,
    staff_id: 1,
    staff_code: "JS",
    staff_name: "Jo Smith",
    hour: 9,
    role: "phones",
    note: null,
    ...overrides,
  };
}

export function makeReceptionRota(overrides: Partial<ReceptionRota> = {}): ReceptionRota {
  return {
    rota_id: 1,
    date: "2026-08-03",
    created_at: "2026-07-29T09:00:00Z",
    sessions: [],
    issues: [],
    staff_on_leave: [],
    ...overrides,
  };
}

let leaveIdCounter = 1;

export function makeReceptionLeaveEntry(
  overrides: Partial<ReceptionLeaveEntry> = {},
): ReceptionLeaveEntry {
  return {
    id: leaveIdCounter++,
    staff_id: 1,
    date: "2026-08-03",
    ...overrides,
  };
}
