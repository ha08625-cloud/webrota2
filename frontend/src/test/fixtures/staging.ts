import type { Staging, StagingNote, StagingSession } from "@/api/types";

let sessionIdCounter = 1;

export function makeStagingSession(overrides: Partial<StagingSession> = {}): StagingSession {
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
    is_on_leave: false,
    is_extra_session: false,
    ...overrides,
  };
}

export function makeStaging(overrides: Partial<Staging> = {}): Staging {
  return {
    staging_id: 1,
    config_id: 1,
    start_date: "2026-08-03",
    num_weeks: 1,
    created_at: "2026-07-20T00:00:00Z",
    completed_at: null,
    closed_slots: [],
    sessions: [],
    notes: [],
    ...overrides,
  };
}
let stagingNoteIdCounter = 1;

/** A per-run note instance. source_note_id defaults to a definition id -
 * the picked-from-the-library case; pass null for a free-form one-off. */
export function makeStagingNote(overrides: Partial<StagingNote> = {}): StagingNote {
  return {
    id: stagingNoteIdCounter++,
    source_note_id: 1,
    text: "Partners meeting",
    week: 1,
    day: "Monday",
    period: "PM",
    doctor_ids: [1],
    ...overrides,
  };
}
