/**
 * Wire mirrors for the Nurse Rota API (`backend/app/api/schemas/nurse_rota.py`).
 *
 * These live in the feature folder rather than in `src/api/types.ts`, per
 * "Adding a Module" in `documentation/architecture.md`: a section owns its
 * own wire types. The one exception is the `nurse_rota` key on
 * `Permissions`, which is shared and stays in `src/api/types.ts`.
 *
 * Session rows are `MasterRotaSession`, imported rather than re-declared:
 * the nurse rota is a second view over the same table the master rota
 * edits, the backend reuses `MasterRotaSessionOut` verbatim for it, and a
 * parallel interface here would be a copy that could drift from the one
 * thing it must match.
 */
import type { Day, MasterRotaSession, Period, Room } from "@/api/types";

/**
 * The three session types a nurse row may hold, narrower than the master
 * template's five. `requires_room` is a bug state rather than a
 * choice - nurses are inert to the engine, so no phase ever rooms one -
 * and `wfh` is meaningless for a nurse. The backend rejects the other two
 * with a 422; this type is what stops the frontend offering them.
 */
export type NurseSessionType = "pre_assigned" | "admin_time" | "no_surgery";

/**
 * A room held by a NON-nurse in one template slot. The nurse page holds
 * nurse rows only, so without this the grid could not tell which rooms
 * are already taken, and a nurse picking an occupied room would get a
 * bare 409 with no way to find a free one.
 *
 * It deliberately crosses room occupancy and the holder's code and
 * nothing else - no session type, no session id, no name.
 */
export interface NurseSlotOccupancy {
  week: number;
  day: Day;
  period: Period;
  room_id: number;
  room_code: string;
  doctor_code: string;
}

/**
 * GET /nurse-rota/active. Rooms ride along because `GET /rooms` is
 * clinical-gated and a nurse_rota-only login cannot reach it, so
 * this is one fetch for the whole page.
 */
export interface NurseRota {
  template_id: number;
  name: string;
  sessions: MasterRotaSession[];
  rooms: Room[];
  occupancy: NurseSlotOccupancy[];
}

// --- Nurse staff ---
// Responses are `Doctor`, imported from `@/api/types` rather than
// re-declared here, for the same reason session rows are: the backend
// reuses `DoctorOut` verbatim for every nurse staff endpoint (see
// `schemas/nurse_rota.py`), and a parallel interface would be a copy that
// could drift from the one thing it must match. `DoctorUsage` and
// `DoctorDeleteResult` are reused for the same reason.
//
// The write bodies are the exception, and are the whole point of the
// section: `NurseIn`/`NursePatch` are narrower than `DoctorIn`/`DoctorPatch`
// by design, and a field added to the doctor bodies later must not silently
// widen what this section can write.

/**
 * POST /nurse-rota/nurses. No `doctor_type` - the router sets NURSE itself,
 * and a payload field would let a nurse_rota-only login mint a Partner. No
 * `active` either: the router creates active rows and deactivation is a
 * PATCH.
 */
export interface NurseIn {
  code: string;
  /** Employment window; null means unbounded at that end. */
  start_date?: string | null;
  end_date?: string | null;
}

/**
 * PATCH /nurse-rota/nurses/{id}. Every field optional; only supplied fields
 * are applied. `doctor_type` is absent for the reason it is absent from
 * `NurseIn`, plus one: were it patchable, the backend's
 * 404-unless-nurse guard would be worth nothing, since a nurse could be
 * promoted out of the partition one request later.
 */
export interface NursePatch {
  code?: string;
  active?: boolean;
  start_date?: string | null;
  end_date?: string | null;
}
