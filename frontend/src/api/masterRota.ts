import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { apiClient } from "./client";
import type { MasterRotaSession, MasterRotaTemplate, MasterSessionType } from "./types";

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

interface UpdateMasterSessionResponse {
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
      apiClient.patch<UpdateMasterSessionResponse>(
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