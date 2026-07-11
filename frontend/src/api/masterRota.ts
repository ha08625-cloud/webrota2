import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { apiClient } from "./client";
import type { Day, MasterRotaSession, MasterRotaTemplate, MasterSessionType, Period } from "./types";

export const masterRotaKeys = {
  all: ["master-rota"] as const,
  active: () => [...masterRotaKeys.all, "active"] as const,
};

/**
 * The active master template. 404 (no active template) surfaces via
 * ApiError.status, handled by MasterRotaPage.
 */
export function useActiveMasterRota() {
  return useQuery({
    queryKey: masterRotaKeys.active(),
    queryFn: () => apiClient.get<MasterRotaTemplate>("/master-rota/active"),
  });
}

// --- Session editing (M4.3 Task 2) ---
// PATCH is a verbatim (session_type, room_id) pair setter with server-side
// room displacement - see backend routers/master_rota.py's patch_session
// docstring. This hook is a thin wire wrapper: it splices the response
// session(s) directly into the active-template cache, same
// splice-in-place/no-invalidate pattern as api/rota.ts's updateRotaCache.

export interface UpdateMasterSessionPayload {
  templateId: number;
  sessionId: number;
  sessionType: MasterSessionType;
  roomId: number | null;
}

/**
 * Shared { session, displaced_session } response shape for PATCH, POST,
 * and (implicitly) DELETE's absence of a body - mirrors the backend's
 * M4.4 rename of MasterSessionPatchOut to MasterSessionWriteOut, since
 * this is now the create response too, not just the patch response.
 */
interface MasterSessionWriteResponse {
  session: MasterRotaSession;
  displaced_session: MasterRotaSession | null;
}

function spliceMasterSessions(
  sessions: MasterRotaSession[],
  updated: MasterRotaSession[],
): MasterRotaSession[] {
  const byId = new Map(updated.map((s) => [s.session_id, s]));
  return sessions.map((s) => byId.get(s.session_id) ?? s);
}

function updatedMasterSessionsFrom(
  session: MasterRotaSession,
  displaced: MasterRotaSession | null,
): MasterRotaSession[] {
  return displaced === null ? [session] : [session, displaced];
}

export function useUpdateMasterSession() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ templateId, sessionId, sessionType, roomId }: UpdateMasterSessionPayload) =>
      apiClient.patch<MasterSessionWriteResponse>(
        `/master-rota/templates/${templateId}/sessions/${sessionId}`,
        { session_type: sessionType, room_id: roomId },
      ),
    onSuccess: (data) => {
      const updated = updatedMasterSessionsFrom(data.session, data.displaced_session);
      queryClient.setQueryData<MasterRotaTemplate | undefined>(masterRotaKeys.active(), (prev) => {
        if (prev === undefined) return prev;
        return { ...prev, sessions: spliceMasterSessions(prev.sessions, updated) };
      });
    },
  });
}

// --- Session create/delete (M4.4 Task 2) ---
// POST/DELETE mirror the same splice-in-place/no-invalidate philosophy as
// PATCH above, but the cache operation differs: create has no existing row
// to match by session_id, so the new session is appended rather than
// spliced (a displaced session, if any, is still spliced in place via the
// existing helper - only the new row itself needs the append). Delete
// filters the row out entirely.

export interface CreateMasterSessionPayload {
  templateId: number;
  doctorId: number;
  week: number;
  day: Day;
  period: Period;
  sessionType: MasterSessionType;
  roomId: number | null;
}

/**
 * Appends `created` to `sessions` and splices `displaced` into place if
 * present, reusing spliceMasterSessions for the displaced half rather
 * than duplicating its byId-map logic. Wraps rather than modifies the
 * PATCH-era splice helper since PATCH has no append case of its own.
 */
function appendMasterSession(
  sessions: MasterRotaSession[],
  created: MasterRotaSession,
  displaced: MasterRotaSession | null,
): MasterRotaSession[] {
  const withCreated = [...sessions, created];
  return displaced === null ? withCreated : spliceMasterSessions(withCreated, [displaced]);
}

export function useCreateMasterSession() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ templateId, doctorId, week, day, period, sessionType, roomId }: CreateMasterSessionPayload) =>
      apiClient.post<MasterSessionWriteResponse>(
        `/master-rota/templates/${templateId}/sessions`,
        {
          doctor_id: doctorId,
          week,
          day,
          period,
          session_type: sessionType,
          room_id: roomId,
        },
      ),
    onSuccess: (data) => {
      queryClient.setQueryData<MasterRotaTemplate | undefined>(masterRotaKeys.active(), (prev) => {
        if (prev === undefined) return prev;
        return { ...prev, sessions: appendMasterSession(prev.sessions, data.session, data.displaced_session) };
      });
    },
  });
}

export interface DeleteMasterSessionPayload {
  templateId: number;
  sessionId: number;
}

export function useDeleteMasterSession() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ templateId, sessionId }: DeleteMasterSessionPayload) =>
      apiClient.delete<void>(`/master-rota/templates/${templateId}/sessions/${sessionId}`),
    onSuccess: (_data, { sessionId }) => {
      queryClient.setQueryData<MasterRotaTemplate | undefined>(masterRotaKeys.active(), (prev) => {
        if (prev === undefined) return prev;
        return { ...prev, sessions: prev.sessions.filter((s) => s.session_id !== sessionId) };
      });
    },
  });
}