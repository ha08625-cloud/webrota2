import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { apiClient } from "./client";
import { rotaKeys } from "./rota";
import type {
  ApiError,
  CreateStagingIn,
  Day,
  GenerateRotaOut,
  MasterSessionType,
  Period,
  Staging,
  StagingSession,
  StagingSessionWriteOut,
} from "./types";

export const stagingKeys = {
  all: ["staging"] as const,
  active: () => [...stagingKeys.all, "active"] as const,
};

/**
 * The active staging, if any. At most one staging exists globally
 * (staging plan, Design Decision 7), so this is the only read hook this
 * module needs - there is no list or detail-by-id query.
 *
 * GET /staging/active 404s when nothing is active; that is a normal,
 * expected state here (not an error condition), so it resolves to null
 * rather than surfacing as a query error - RotaPage branches on
 * data === null to decide between "start staging" and "resume" without
 * needing to inspect error state at all.
 */
export function useActiveStaging() {
  return useQuery({
    queryKey: stagingKeys.active(),
    queryFn: async (): Promise<Staging | null> => {
      try {
        return await apiClient.get<Staging>("/staging/active");
      } catch (err) {
        if ((err as ApiError).status === 404) {
          return null;
        }
        throw err;
      }
    },
  });
}

export function useCreateStaging() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (payload: CreateStagingIn) => apiClient.post<Staging>("/staging", payload),
    onSuccess: (data) => {
      queryClient.setQueryData<Staging | null>(stagingKeys.active(), data);
    },
  });
}

// --- Session editing ---
// Mirrors masterRota.ts's splice-in-place/no-invalidate pattern exactly,
// with one structural difference: sessions nest inside the cached Staging
// object rather than being the cache root, so every splice rebuilds
// { ...staging, sessions } instead of replacing the root directly.

function spliceStagingSessions(
  sessions: StagingSession[],
  updated: StagingSession[],
): StagingSession[] {
  const byId = new Map(updated.map((s) => [s.session_id, s]));
  return sessions.map((s) => byId.get(s.session_id) ?? s);
}

function updatedStagingSessionsFrom(
  session: StagingSession,
  displaced: StagingSession | null,
): StagingSession[] {
  return displaced === null ? [session] : [session, displaced];
}

export interface UpdateStagingSessionPayload {
  stagingId: number;
  sessionId: number;
  sessionType: MasterSessionType;
  roomId: number | null;
}

export function useUpdateStagingSession() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ stagingId, sessionId, sessionType, roomId }: UpdateStagingSessionPayload) =>
      apiClient.patch<StagingSessionWriteOut>(
        `/staging/${stagingId}/sessions/${sessionId}`,
        { session_type: sessionType, room_id: roomId },
      ),
    onSuccess: (data) => {
      const updated = updatedStagingSessionsFrom(data.session, data.displaced_session);
      queryClient.setQueryData<Staging | null | undefined>(stagingKeys.active(), (prev) => {
        if (prev === undefined || prev === null) return prev;
        return { ...prev, sessions: spliceStagingSessions(prev.sessions, updated) };
      });
    },
  });
}

export interface CreateStagingSessionPayload {
  stagingId: number;
  doctorId: number;
  week: number;
  day: Day;
  period: Period;
  sessionType: MasterSessionType;
  roomId: number | null;
}

/**
 * Appends `created` and splices `displaced` into place if present - same
 * append-plus-splice shape as masterRota.ts's appendMasterSession.
 */
function appendStagingSession(
  sessions: StagingSession[],
  created: StagingSession,
  displaced: StagingSession | null,
): StagingSession[] {
  const withCreated = [...sessions, created];
  return displaced === null ? withCreated : spliceStagingSessions(withCreated, [displaced]);
}

export function useCreateStagingSession() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ stagingId, doctorId, week, day, period, sessionType, roomId }: CreateStagingSessionPayload) =>
      apiClient.post<StagingSessionWriteOut>(
        `/staging/${stagingId}/sessions`,
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
      queryClient.setQueryData<Staging | null | undefined>(stagingKeys.active(), (prev) => {
        if (prev === undefined || prev === null) return prev;
        return { ...prev, sessions: appendStagingSession(prev.sessions, data.session, data.displaced_session) };
      });
    },
  });
}

export interface DeleteStagingSessionPayload {
  stagingId: number;
  sessionId: number;
}

export function useDeleteStagingSession() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ stagingId, sessionId }: DeleteStagingSessionPayload) =>
      apiClient.delete<void>(`/staging/${stagingId}/sessions/${sessionId}`),
    onSuccess: (_data, { sessionId }) => {
      queryClient.setQueryData<Staging | null | undefined>(stagingKeys.active(), (prev) => {
        if (prev === undefined || prev === null) return prev;
        return { ...prev, sessions: prev.sessions.filter((s) => s.session_id !== sessionId) };
      });
    },
  });
}

// --- Lifecycle: abandon / complete ---

/**
 * Hard-deletes the active staging and its RotaConfig (staging plan,
 * Design Decision 3). The active-staging cache is set to null directly
 * rather than invalidated - there is nothing left on the server to
 * refetch that would produce a different result.
 */
export function useAbandonStaging() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (stagingId: number) => apiClient.delete<void>(`/staging/${stagingId}`),
    onSuccess: () => {
      queryClient.setQueryData<Staging | null>(stagingKeys.active(), null);
    },
  });
}

/**
 * Runs the Phase 0-12 pipeline against the staged copy and marks it
 * completed, returning the same GenerateRotaOut shape as
 * useGenerateRota (rota.ts). On success the active-staging cache clears
 * (there is no longer an active staging) and the rota list is
 * invalidated so RotaPage picks up the new draft, mirroring
 * useGenerateRota's own invalidation.
 */
export function useCompleteStaging() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (stagingId: number) => apiClient.post<GenerateRotaOut>(`/staging/${stagingId}/complete`),
    onSuccess: () => {
      queryClient.setQueryData<Staging | null>(stagingKeys.active(), null);
      queryClient.invalidateQueries({ queryKey: rotaKeys.list() });
    },
  });
}