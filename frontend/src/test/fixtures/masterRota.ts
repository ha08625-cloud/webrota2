import type { MasterRotaSession, MasterRotaTemplate } from "@/api/types";

let sessionIdCounter = 1;

export function makeMasterRotaSession(
  overrides: Partial<MasterRotaSession> = {},
): MasterRotaSession {
  return {
    session_id: sessionIdCounter++,
    doctor_id: 1,
    doctor_code: "AB",
    doctor_type: "Partner",
    week: 1,
    day: "Monday",
    period: "AM",
    session_type: "requires_room",
    room_id: null,
    room_code: null,
    ...overrides,
  };
}

export function makeMasterRotaTemplate(
  overrides: Partial<MasterRotaTemplate> = {},
): MasterRotaTemplate {
  return {
    template_id: 1,
    name: "Default",
    sessions: [],
    ...overrides,
  };
}