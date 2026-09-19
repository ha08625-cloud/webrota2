import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { apiClient } from "@/api/client";
import type {
  Day,
  Doctor,
  DoctorDeleteResult,
  DoctorUsage,
  MasterRotaSession,
  Period,
} from "@/api/types";

import type { NurseIn, NursePatch, NurseRota, NurseSessionType } from "./types";

/**
 * TanStack Query hooks for the Nurse Rota section.
 *
 * The section owns its own hooks (`features/nurseRota/api.ts`) rather
 * than adding a module to the flat `src/api/` tree - see "Adding a
 * Module" in `documentation/architecture.md`. It still imports the
 * shared `api/client.ts`, which is infrastructure rather than another
 * section's code.
 *
 * Its own query key, separate from `masterRotaKeys`, even though the two
 * sections read the same table: they are different payloads (nurse rows
 * plus occupancy here, every row there), and it is accepted that an edit in
 * one page is not reflected in an already-open other page until it
 * refetches.
 *
 * Write paths carry no template_id - the nurse surface only ever
 * edits the active template, which the router resolves itself.
 */
export const nurseRotaKeys = {
  all: ["nurse-rota"] as const,
  active: () => [...nurseRotaKeys.all, "active"] as const,
  nurses: (includeInactive: boolean) =>
    [...nurseRotaKeys.all, "nurses", includeInactive] as const,
  nurseUsage: (nurseId: number) => [...nurseRotaKeys.all, "nurses", "usage", nurseId] as const,
};

/**
 * The active template's nurse rows, the room list and non-nurse room
 * occupancy, in one fetch. 404 (no active template) surfaces via
 * ApiError.status, handled by NurseRotaPage.
 */
export function useActiveNurseRota() {
  return useQuery({
    queryKey: nurseRotaKeys.active(),
    queryFn: () => apiClient.get<NurseRota>("/nurse-rota/active"),
  });
}

// --- Session editing ---
// Same splice-in-place/no-invalidate convention as api/masterRota.ts: the
// write endpoints return the session(s) they changed, so the cached
// payload is patched from the response rather than refetched.
//
// `occupancy` is never touched by any of these. It lists non-nurse
// holders only, and a nurse write can never move one: the backend 409s
// instead of displacing. Every displacement a response can report
// is nurse-on-nurse, which lives in `sessions`.

/** Shared response shape for PATCH and POST (backend: NurseSessionWriteOut). */
interface NurseSessionWriteResponse {
  session: MasterRotaSession;
  displaced_session: MasterRotaSession | null;
}

function spliceNurseSessions(
  sessions: MasterRotaSession[],
  updated: MasterRotaSession[],
): MasterRotaSession[] {
  const byId = new Map(updated.map((s) => [s.session_id, s]));
  return sessions.map((s) => byId.get(s.session_id) ?? s);
}

function updatedNurseSessionsFrom(
  session: MasterRotaSession,
  displaced: MasterRotaSession | null,
): MasterRotaSession[] {
  return displaced === null ? [session] : [session, displaced];
}

export interface UpdateNurseSessionPayload {
  sessionId: number;
  sessionType: NurseSessionType;
  roomId: number | null;
}

export function useUpdateNurseSession() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ sessionId, sessionType, roomId }: UpdateNurseSessionPayload) =>
      apiClient.patch<NurseSessionWriteResponse>(`/nurse-rota/sessions/${sessionId}`, {
        session_type: sessionType,
        room_id: roomId,
      }),
    onSuccess: (data) => {
      const updated = updatedNurseSessionsFrom(data.session, data.displaced_session);
      queryClient.setQueryData<NurseRota | undefined>(nurseRotaKeys.active(), (prev) => {
        if (prev === undefined) return prev;
        return { ...prev, sessions: spliceNurseSessions(prev.sessions, updated) };
      });
    },
  });
}

export interface CreateNurseSessionPayload {
  doctorId: number;
  week: number;
  day: Day;
  period: Period;
  sessionType: NurseSessionType;
  roomId: number | null;
}

/**
 * Appends `created` and splices `displaced` into place if present,
 * reusing spliceNurseSessions for the displaced half - only the new row
 * itself needs the append, since it has no existing entry to match by
 * session_id.
 */
function appendNurseSession(
  sessions: MasterRotaSession[],
  created: MasterRotaSession,
  displaced: MasterRotaSession | null,
): MasterRotaSession[] {
  const withCreated = [...sessions, created];
  return displaced === null ? withCreated : spliceNurseSessions(withCreated, [displaced]);
}

export function useCreateNurseSession() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ doctorId, week, day, period, sessionType, roomId }: CreateNurseSessionPayload) =>
      apiClient.post<NurseSessionWriteResponse>("/nurse-rota/sessions", {
        doctor_id: doctorId,
        week,
        day,
        period,
        session_type: sessionType,
        room_id: roomId,
      }),
    onSuccess: (data) => {
      queryClient.setQueryData<NurseRota | undefined>(nurseRotaKeys.active(), (prev) => {
        if (prev === undefined) return prev;
        return {
          ...prev,
          sessions: appendNurseSession(prev.sessions, data.session, data.displaced_session),
        };
      });
    },
  });
}

export interface DeleteNurseSessionPayload {
  sessionId: number;
}

export function useDeleteNurseSession() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ sessionId }: DeleteNurseSessionPayload) =>
      apiClient.delete<void>(`/nurse-rota/sessions/${sessionId}`),
    onSuccess: (_data, { sessionId }) => {
      queryClient.setQueryData<NurseRota | undefined>(nurseRotaKeys.active(), (prev) => {
        if (prev === undefined) return prev;
        return { ...prev, sessions: prev.sessions.filter((s) => s.session_id !== sessionId) };
      });
    },
  });
}

// --- Nurse staff ---
// Reference data, and deliberately NOT the splice-in-place convention the
// session hooks above use: these lists are small, nobody is mid-gesture
// when they fire, and a create has no cached row to patch. Invalidate off
// `nurseRotaKeys.all` so both `include_inactive` variants of the list are
// covered by one call - a deactivation moves a row between them, so
// invalidating only the variant the caller read would leave the other
// stale.

/**
 * The section's nurses. Its own endpoint rather than `GET /doctors`
 * filtered client-side: that route is one of the two deliberate holes in
 * default-deny (`deps._SHARED_READ`), open for the user-admin
 * linked-doctor picker rather than for this page.
 */
export function useNurses(includeInactive = false) {
  return useQuery({
    queryKey: nurseRotaKeys.nurses(includeInactive),
    queryFn: () =>
      apiClient.get<Doctor[]>(`/nurse-rota/nurses?include_inactive=${includeInactive}`),
  });
}

export function useCreateNurse() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (payload: NurseIn) => apiClient.post<Doctor>("/nurse-rota/nurses", payload),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: nurseRotaKeys.all });
    },
  });
}

export interface UpdateNursePayload {
  id: number;
  payload: NursePatch;
}

export function useUpdateNurse() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, payload }: UpdateNursePayload) =>
      apiClient.patch<Doctor>(`/nurse-rota/nurses/${id}`, payload),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: nurseRotaKeys.all });
    },
  });
}

/**
 * What a permanent delete would destroy, read by the confirm dialog before
 * it asks. Pass null to keep it unfetched - the dialog passes the id only
 * while it is open, so a closed dialog costs nothing.
 */
export function useNurseUsage(nurseId: number | null) {
  return useQuery({
    queryKey: nurseRotaKeys.nurseUsage(nurseId ?? 0),
    queryFn: () => apiClient.get<DoctorUsage>(`/nurse-rota/nurses/${nurseId}/usage`),
    enabled: nurseId !== null,
  });
}

/**
 * Permanent purge. Deactivation is useUpdateNurse with {active: false};
 * this is the irreversible one, and the backend 409s unless the nurse is
 * already inactive.
 *
 * Invalidating off `nurseRotaKeys.all` matters most here: it takes
 * `active()` with it, and `MasterRotaSession` is in the backend's
 * PURGED_MODELS, so the purge deletes the nurse's template rows and the
 * rota grid's cached payload is stale the moment it returns. Without that
 * the staff page leaves ghost rows on the grid.
 */
export function useDeleteNurse() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: number) => apiClient.delete<DoctorDeleteResult>(`/nurse-rota/nurses/${id}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: nurseRotaKeys.all });
    },
  });
}
