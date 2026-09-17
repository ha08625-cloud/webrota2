import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { apiClient } from "@/api/client";
import type { Day, MasterRotaSession, Period } from "@/api/types";

import type { NurseRota, NurseSessionType } from "./types";

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
 * plus occupancy here, every row there), and DD4 accepts that an edit in
 * one page is not reflected in an already-open other page until it
 * refetches.
 *
 * Write paths carry no template_id (DD11a) - the nurse surface only ever
 * edits the active template, which the router resolves itself.
 */
export const nurseRotaKeys = {
  all: ["nurse-rota"] as const,
  active: () => [...nurseRotaKeys.all, "active"] as const,
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
// instead of displacing (DD5). Every displacement a response can report
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
