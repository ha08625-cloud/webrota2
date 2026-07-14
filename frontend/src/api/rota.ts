import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { apiClient } from "./client";
import type {
  GenerateRotaIn,
  GenerateRotaOut,
  Rota,
  RotaSession,
  RotaSummary,
  SessionRole,
  MasterSessionType,
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

/**
 * Undoes a commit one step back through commit history (M3.7): restores
 * the rota's counters from its snapshot and flips it back to draft. The
 * response is a RotaOut with status="draft", same shape as commit's
 * response - the caller re-renders into the normal draft-editing view
 * off the same detail query, no navigation needed. Both list (for the
 * rollback-eligibility check on other rows) and this rota's own detail
 * are invalidated, matching the commit/scrap invalidation pattern.
 */
export function useRollbackCommit() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (rotaId: number) => apiClient.post<Rota>(`/rota/${rotaId}/rollback-commit`),
    onSuccess: (data, rotaId) => {
      queryClient.setQueryData(rotaKeys.detail(rotaId), data);
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
  /**
   * Optional, unlike isWfh/notes (Phase 9C plan, section 5): the
   * popover's always-send-all-three contract needs it present, but
   * set-room's WFH-restore follow-up patch (replayUndo.ts) has no
   * previous value to supply and must not overwrite is_supervising with
   * a stale one. Included in the request body only when defined.
   */
  isSupervising?: boolean;
}

interface PatchSessionResponse {
  session: RotaSession;
  issues: ValidationIssue[];
}

/**
 * Partial update of is_wfh, notes, and/or is_supervising. The popover's
 * own payload always sends all three (see CellEditPopover) - the
 * endpoint's model_fields_set-based partial-update support is a backend
 * capability this hook doesn't need to expose for that caller, since
 * nothing in the menu UI sends a true subset. isSupervising is the one
 * exception: it's genuinely optional here because the set-room
 * WFH-restore follow-up (replayUndo.ts) reuses this same mutation with
 * no previous is_supervising value to send.
 *
 * Setting is_wfh true clears room_id server-side; setting it back false
 * does NOT restore a room (SessionPatchIn's own docstring) - PATCH has no
 * room_id field. This was a permanent gap through M4: there was no API
 * path to restore a cleared room at all, so RotaDetailPage's undo
 * handling surfaced it as a caveat toast rather than silently returning
 * a "successful" undo that didn't fully restore state. M4.1 Task 1's
 * nullable set-room closes the gap - replayUndo's upgraded "patch" replay
 * sequence now follows a PATCH restore with a set-room call when needed,
 * and the caveat toast path has been removed.
 */
export function usePatchSession() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ rotaId, sessionId, isWfh, notes, isSupervising }: PatchSessionPayload) =>
      apiClient.patch<PatchSessionResponse>(`/rota/${rotaId}/sessions/${sessionId}`, {
        is_wfh: isWfh,
        notes,
        ...(isSupervising !== undefined ? { is_supervising: isSupervising } : {}),
      }),
    onSuccess: (data, { rotaId }) => {
      updateRotaCache(queryClient, rotaId, [data.session]);
      updateIssuesCache(queryClient, rotaId, data.issues);
    },
  });
}

// --- Cell edit menu: set-room / set-role (M4.1 Task 2) ---
// Both mirror the PATCH/swap pattern above: splice the response session(s)
// into the rota cache, write fresh issues, no invalidate/refetch.

export interface SetRoomPayload {
  rotaId: number;
  sessionId: number;
  roomId: number | null;
}

interface SetRoomResponse {
  session: RotaSession;
  displaced_session: RotaSession | null;
  issues: ValidationIssue[];
}

function updatedSessionsFrom(session: RotaSession, displaced: RotaSession | null): RotaSession[] {
  return displaced === null ? [session] : [session, displaced];
}

/**
 * One-sided room assign/clear with server-side displacement. room_id
 * null clears the target's room. See backend set_room docstring for the
 * steal/no-op semantics; this hook is a thin wire wrapper with no
 * client-side displacement logic of its own (that lives in
 * slotConflict.ts, and is advisory only - the server's own lookup is the
 * source of truth for what actually happens).
 */
export function useSetRoom() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ rotaId, sessionId, roomId }: SetRoomPayload) =>
      apiClient.post<SetRoomResponse>(`/rota/${rotaId}/sessions/${sessionId}/set-room`, {
        room_id: roomId,
      }),
    onSuccess: (data, { rotaId }) => {
      updateRotaCache(queryClient, rotaId, updatedSessionsFrom(data.session, data.displaced_session));
      updateIssuesCache(queryClient, rotaId, data.issues);
    },
  });
}

export interface SetRoleTriple {
  role: SessionRole | null;
  clinicTypeId: number | null;
  templateType: MasterSessionType | null;
}

export interface SetRolePayload {
  rotaId: number;
  sessionId: number;
  triple: SetRoleTriple;
}

interface SetRoleResponse {
  session: RotaSession;
  displaced_session: RotaSession | null;
  issues: ValidationIssue[];
}

/**
 * Verbatim (role, clinic_type_id, template_type) triple setter with
 * server-side displacement for steal-class assignments. The caller
 * (CellEditPopover / RotaGrid / replayUndo) is responsible for the
 * template_type it sends - this hook does not infer or preserve it.
 */
export function useSetRole() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ rotaId, sessionId, triple }: SetRolePayload) =>
      apiClient.post<SetRoleResponse>(`/rota/${rotaId}/sessions/${sessionId}/set-role`, {
        role: triple.role,
        clinic_type_id: triple.clinicTypeId,
        template_type: triple.templateType,
      }),
    onSuccess: (data, { rotaId }) => {
      updateRotaCache(queryClient, rotaId, updatedSessionsFrom(data.session, data.displaced_session));
      updateIssuesCache(queryClient, rotaId, data.issues);
    },
  });
}