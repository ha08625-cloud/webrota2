import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { apiClient } from "./client";
import type {
  GenerateRotaIn,
  GenerateRotaOut,
  Rota,
  RotaSession,
  RotaSummary,
  ValidationIssue,
} from "./types";

export const rotaKeys = {
  all: ["rota"] as const,
  list: () => [...rotaKeys.all, "list"] as const,
  detail: (rotaId: number) => [...rotaKeys.all, "detail", rotaId] as const,
  issues: (rotaId: number) => [...rotaKeys.all, "issues", rotaId] as const,
};

export function useRotaList() {
  return useQuery({
    queryKey: rotaKeys.list(),
    queryFn: () => apiClient.get<RotaSummary[]>("/rota"),
  });
}

export function useRota(rotaId: number) {
  return useQuery({
    queryKey: rotaKeys.detail(rotaId),
    queryFn: () => apiClient.get<Rota>(`/rota/${rotaId}`),
    enabled: Number.isFinite(rotaId),
  });
}

/**
 * GET /rota/{id}/issues is a separate endpoint from GET /rota/{id} - it
 * re-runs Phase 12 live rather than returning a snapshot embedded in the
 * rota payload. Every swap/move/patch mutation below writes its own
 * fresh issues directly into this query's cache (see updateIssuesCache),
 * so this hook's queryFn only actually fires on first load / a hard
 * refetch, not after every edit.
 */
export function useRotaIssues(rotaId: number) {
  return useQuery({
    queryKey: rotaKeys.issues(rotaId),
    queryFn: () => apiClient.get<ValidationIssue[]>(`/rota/${rotaId}/issues`),
    enabled: Number.isFinite(rotaId),
  });
}

export function useGenerateRota() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (payload: GenerateRotaIn) => apiClient.post<GenerateRotaOut>("/rota/generate", payload),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: rotaKeys.list() });
    },
  });
}

export function useCommitRota() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (rotaId: number) => apiClient.post<Rota>(`/rota/${rotaId}/commit`),
    onSuccess: (data, rotaId) => {
      queryClient.setQueryData(rotaKeys.detail(rotaId), data);
      queryClient.invalidateQueries({ queryKey: rotaKeys.list() });
    },
  });
}

export function useScrapRota() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (rotaId: number) => apiClient.delete<void>(`/rota/${rotaId}`),
    onSuccess: (_data, rotaId) => {
      queryClient.removeQueries({ queryKey: rotaKeys.detail(rotaId) });
      queryClient.invalidateQueries({ queryKey: rotaKeys.list() });
    },
  });
}

// --- Session editing (Task 4) ---
// swap-roles, swap-rooms, and the session PATCH all return the full
// updated session(s) plus a fresh issues list. None of these invalidate
// and refetch the whole rota - they splice the response directly into
// the existing caches, per the M4 plan ("optimistic-free updates from
// response payloads").

function spliceSessions(sessions: RotaSession[], updated: RotaSession[]): RotaSession[] {
  const byId = new Map(updated.map((s) => [s.session_id, s]));
  return sessions.map((s) => byId.get(s.session_id) ?? s);
}

function updateRotaCache(
  queryClient: ReturnType<typeof useQueryClient>,
  rotaId: number,
  updatedSessions: RotaSession[],
) {
  queryClient.setQueryData<Rota | undefined>(rotaKeys.detail(rotaId), (prev) => {
    if (prev === undefined) return prev;
    return { ...prev, sessions: spliceSessions(prev.sessions, updatedSessions) };
  });
}

function updateIssuesCache(
  queryClient: ReturnType<typeof useQueryClient>,
  rotaId: number,
  issues: ValidationIssue[],
) {
  queryClient.setQueryData(rotaKeys.issues(rotaId), issues);
}

export interface SwapPayload {
  rotaId: number;
  sessionAId: number;
  sessionBId: number;
}

interface SwapResponse {
  session_a: RotaSession;
  session_b: RotaSession;
  issues: ValidationIssue[];
}

/**
 * Swaps or moves (role, clinic_type_id) between two draft sessions.
 * Also serves as the undo for itself: repeating the same call with the
 * same two ids is a true inverse (the endpoint's field-exchange is
 * symmetric, including the clinic-counter adjustments), for both a true
 * swap and a move (one side null) - "swap: repeat" and "move: move
 * back" in the M4 plan are the same mechanism, not two.
 */
export function useSwapRoles() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ rotaId, sessionAId, sessionBId }: SwapPayload) =>
      apiClient.post<SwapResponse>(`/rota/${rotaId}/swap-roles`, {
        session_a_id: sessionAId,
        session_b_id: sessionBId,
      }),
    onSuccess: (data, { rotaId }) => {
      updateRotaCache(queryClient, rotaId, [data.session_a, data.session_b]);
      updateIssuesCache(queryClient, rotaId, data.issues);
    },
  });
}

/** Swaps or moves room_id between two draft sessions. Same inverse-by-repetition property as swap-roles. */
export function useSwapRooms() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ rotaId, sessionAId, sessionBId }: SwapPayload) =>
      apiClient.post<SwapResponse>(`/rota/${rotaId}/swap-rooms`, {
        session_a_id: sessionAId,
        session_b_id: sessionBId,
      }),
    onSuccess: (data, { rotaId }) => {
      updateRotaCache(queryClient, rotaId, [data.session_a, data.session_b]);
      updateIssuesCache(queryClient, rotaId, data.issues);
    },
  });
}

export interface PatchSessionPayload {
  rotaId: number;
  sessionId: number;
  isWfh: boolean;
  notes: string | null;
}

interface PatchSessionResponse {
  session: RotaSession;
  issues: ValidationIssue[];
}

/**
 * Partial update of is_wfh and/or notes. This hook's own payload always
 * sends both fields (see CellEditPopover) - the endpoint's
 * model_fields_set-based partial-update support is a backend capability
 * this hook doesn't need to expose, since nothing in Task 4's UI sends a
 * true subset.
 *
 * Setting is_wfh true clears room_id server-side; setting it back false
 * does NOT restore a room (SessionPatchIn's own docstring). There is no
 * API path to restore a cleared room at all - PATCH has no room_id
 * field, and swap-rooms 422s once neither session holds a room. This is
 * a genuine, permanent gap in the frozen M3.5 contract, not something
 * this hook can route around; RotaDetailPage's undo handling surfaces it
 * as a toast rather than silently returning a "successful" undo that
 * didn't fully restore state.
 */
export function usePatchSession() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ rotaId, sessionId, isWfh, notes }: PatchSessionPayload) =>
      apiClient.patch<PatchSessionResponse>(`/rota/${rotaId}/sessions/${sessionId}`, {
        is_wfh: isWfh,
        notes,
      }),
    onSuccess: (data, { rotaId }) => {
      updateRotaCache(queryClient, rotaId, [data.session]);
      updateIssuesCache(queryClient, rotaId, data.issues);
    },
  });
}