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
 * template's five (DD6). `requires_room` is a bug state rather than a
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
 * clinical-gated and a nurse_rota-only login cannot reach it (DD8), so
 * this is one fetch for the whole page.
 */
export interface NurseRota {
  template_id: number;
  name: string;
  sessions: MasterRotaSession[];
  rooms: Room[];
  occupancy: NurseSlotOccupancy[];
}
