import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { apiClient } from "./client";
import type {
  ApiError,
  Day,
  ReceptionCounters,
  ReceptionLeaveBulkDeleteOut,
  ReceptionLeaveBulkOut,
  ReceptionLeaveEntry,
  ReceptionLeaveRangeIn,
  ReceptionMasterSession,
  ReceptionRole,
  ReceptionRota,
  ReceptionRotaSession,
  ReceptionSessionWriteOut,
  ReceptionStaff,
  ReceptionStaffDeleteResult,
  ReceptionStaffIn,
  ReceptionStaffPatch,
  ReceptionStaffUsage,
  ValidationIssue,
} from "./types";

/**
 * Flat, per-resource keys (one file, five routers) - deliberately not
 * nested per-resource objects, since a query key referencing a sibling
 * key from inside the same object literal is a footgun the rest of this
 * codebase's api/*.ts files avoid (rotaKeys, doctorKeys, masterRotaKeys
 * are all flat for the same reason).
 */
export const receptionKeys = {
  staffAll: ["reception", "staff"] as const,
  staffList: (includeInactive: boolean) => ["reception", "staff", "list", includeInactive] as const,
  staffUsage: (staffId: number) => ["reception", "staff", "usage", staffId] as const,

  masterAll: ["reception", "master"] as const,
  masterList: () => ["reception", "master", "list"] as const,

  rotaAll: ["reception", "rota"] as const,
  rotaByDate: (date: string) => ["reception", "rota", "date", date] as const,
  rotaDetail: (rotaId: number) => ["reception", "rota", "detail", rotaId] as const,

  leaveAll: ["reception", "leave"] as const,
  leaveList: (staffId: number | null) => ["reception", "leave", "list", staffId] as const,

  countersAll: ["reception", "counters"] as const,
  countersList: (fromDate: string | null, toDate: string | null) =>
    ["reception", "counters", "list", fromDate, toDate] as const,
};

// --- Reception staff ---
// Reference data - invalidate and refetch on write, same as api/doctors.ts:
// this list is small and nobody is mid-gesture when these mutations fire.

export function useReceptionStaff(includeInactive = false) {
  return useQuery({
    queryKey: receptionKeys.staffList(includeInactive),
    queryFn: () => apiClient.get<ReceptionStaff[]>(`/reception/staff?include_inactive=${includeInactive}`),
  });
}

export function useCreateReceptionStaff() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (payload: ReceptionStaffIn) => apiClient.post<ReceptionStaff>("/reception/staff", payload),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: receptionKeys.staffAll });
    },
  });
}

export interface UpdateReceptionStaffPayload {
  id: number;
  payload: ReceptionStaffPatch;
}

export function useUpdateReceptionStaff() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, payload }: UpdateReceptionStaffPayload) =>
      apiClient.patch<ReceptionStaff>(`/reception/staff/${id}`, payload),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: receptionKeys.staffAll });
    },
  });
}

/**
 * What deleting this staff member would destroy, for the confirm dialog.
 * Its key sits under staffAll, so any staff write already invalidates it.
 * Pass null while no member is chosen; the dialog mounts per row, so in
 * practice this fetches when the dialog opens.
 */
export function useReceptionStaffUsage(staffId: number | null) {
  return useQuery({
    queryKey: receptionKeys.staffUsage(staffId ?? 0),
    queryFn: () => apiClient.get<ReceptionStaffUsage>(`/reception/staff/${staffId}/usage`),
    enabled: staffId !== null,
  });
}

/**
 * DELETE /reception/staff/{id} - a permanent purge, NOT a deactivate.
 * Deactivation is useUpdateReceptionStaff with {active: false}; this
 * removes the staff row and every row referencing it, and 409s unless the
 * member is already inactive (see routers/reception_staff.py).
 *
 * Four roots to invalidate, because the purge reaches all four: the staff
 * list itself, the day rotas it deleted sessions from, the counters
 * derived from those sessions, and the leave entries it deleted - leave is
 * cached per staff by useReceptionLeave, so ReceptionLeavePage would
 * otherwise keep showing rows for someone who no longer exists.
 */
export function useDeleteReceptionStaff() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: number) => apiClient.delete<ReceptionStaffDeleteResult>(`/reception/staff/${id}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: receptionKeys.staffAll });
      queryClient.invalidateQueries({ queryKey: receptionKeys.rotaAll });
      queryClient.invalidateQueries({ queryKey: receptionKeys.countersAll });
      queryClient.invalidateQueries({ queryKey: receptionKeys.leaveAll });
    },
  });
}

// --- Weekday master template ---
// A grid, like the clinical master rota - splice the mutation response
// into the cached list rather than refetch, mirroring api/masterRota.ts.
// Unlike the clinical template there is no displacement (several staff can
// share a (day, hour) slot) and no {session, displaced_session} shape -
// every write returns a bare ReceptionMasterSession.

export function useReceptionMasterSessions() {
  return useQuery({
    queryKey: receptionKeys.masterList(),
    queryFn: () => apiClient.get<ReceptionMasterSession[]>("/reception/master"),
  });
}

function spliceReceptionMasterSession(
  sessions: ReceptionMasterSession[],
  updated: ReceptionMasterSession,
): ReceptionMasterSession[] {
  return sessions.map((s) => (s.session_id === updated.session_id ? updated : s));
}

export interface CreateReceptionMasterSessionPayload {
  staffId: number;
  day: Day;
  hour: number;
  role?: ReceptionRole;
  note?: string | null;
}

export function useCreateReceptionMasterSession() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ staffId, day, hour, role, note }: CreateReceptionMasterSessionPayload) =>
      apiClient.post<ReceptionMasterSession>("/reception/master/sessions", {
        staff_id: staffId,
        day,
        hour,
        role: role ?? "phones",
        note: note ?? null,
      }),
    onSuccess: (created) => {
      queryClient.setQueryData<ReceptionMasterSession[] | undefined>(receptionKeys.masterList(), (prev) =>
        prev === undefined ? prev : [...prev, created],
      );
    },
  });
}

export interface UpdateReceptionMasterSessionPayload {
  sessionId: number;
  role: ReceptionRole;
  note: string | null;
}

/** Verbatim (role, note) pair setter, matching ReceptionMasterSessionPatchIn's not-a-partial-update contract. */
export function useUpdateReceptionMasterSession() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ sessionId, role, note }: UpdateReceptionMasterSessionPayload) =>
      apiClient.patch<ReceptionMasterSession>(`/reception/master/sessions/${sessionId}`, { role, note }),
    onSuccess: (updated) => {
      queryClient.setQueryData<ReceptionMasterSession[] | undefined>(receptionKeys.masterList(), (prev) =>
        prev === undefined ? prev : spliceReceptionMasterSession(prev, updated),
      );
    },
  });
}

export function useDeleteReceptionMasterSession() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (sessionId: number) => apiClient.delete<void>(`/reception/master/sessions/${sessionId}`),
    onSuccess: (_data, sessionId) => {
      queryClient.setQueryData<ReceptionMasterSession[] | undefined>(receptionKeys.masterList(), (prev) =>
        prev === undefined ? prev : prev.filter((s) => s.session_id !== sessionId),
      );
    },
  });
}

// --- Day rota ---
// The day page is date-scoped (one day at a time), so GET-by-date is the
// primary read and the cache session mutations splice into. GET-by-id is
// a secondary lookup the backend also exposes; nothing here writes into
// its cache.

export function useReceptionRotaByDate(date: string | undefined) {
  return useQuery({
    queryKey: receptionKeys.rotaByDate(date ?? ""),
    queryFn: () => apiClient.get<ReceptionRota>(`/reception/rota?date=${date}`),
    enabled: date !== undefined,
    // A 404 (no rota generated yet for this date) is an expected steady
    // state, not a transient failure - the day page reads it to decide
    // between offering "Generate" and rendering the grid.
    retry: false,
  });
}

/**
 * One-shot, imperative read of a date's rota - null on 404, since "no rota
 * generated yet" is an expected answer here rather than a failure.
 *
 * Deliberately not a hook: the week-level "Generate week from template"
 * flow needs to know, on a button press, which of the five weekdays
 * already exist (and their rota ids, to delete before regenerating). That
 * is five reads triggered by a gesture, not five rendered subscriptions.
 */
export async function fetchReceptionRotaByDate(date: string): Promise<ReceptionRota | null> {
  try {
    return await apiClient.get<ReceptionRota>(`/reception/rota?date=${date}`);
  } catch (err) {
    if ((err as ApiError).status === 404) return null;
    throw err;
  }
}

export function useReceptionRota(rotaId: number | undefined) {
  return useQuery({
    queryKey: receptionKeys.rotaDetail(rotaId ?? -1),
    queryFn: () => apiClient.get<ReceptionRota>(`/reception/rota/${rotaId}`),
    enabled: rotaId !== undefined,
  });
}

export function useGenerateReceptionRota() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (date: string) => apiClient.post<ReceptionRota>("/reception/rota", { date }),
    onSuccess: (data, date) => {
      queryClient.setQueryData(receptionKeys.rotaByDate(date), data);
      queryClient.setQueryData(receptionKeys.rotaDetail(data.rota_id), data);
    },
  });
}

export interface AssignReceptionFrontDeskPayload {
  rotaId: number;
  date: string;
}

/**
 * POST /reception/rota/{id}/front-desk - no body. Resets whatever the
 * assigner wrote last time, then chooses and applies a 2-3 block partition
 * of 8:00am-6:00pm.
 *
 * The response is the whole day, not a session delta (it rewrites many rows
 * at once), so this overwrites both caches outright the way
 * useGenerateReceptionRota does rather than splicing. An unsolvable day is
 * still a 200 - it simply comes back carrying front_desk_gap issues.
 */
export function useAssignReceptionFrontDesk() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ rotaId }: AssignReceptionFrontDeskPayload) =>
      apiClient.post<ReceptionRota>(`/reception/rota/${rotaId}/front-desk`),
    onSuccess: (data, { date }) => {
      queryClient.setQueryData(receptionKeys.rotaByDate(date), data);
      queryClient.setQueryData(receptionKeys.rotaDetail(data.rota_id), data);
    },
  });
}

export interface DeleteReceptionRotaPayload {
  rotaId: number;
  date: string;
}

/** Backs the delete-then-generate "Regenerate" flow - the date becomes generatable again. */
export function useDeleteReceptionRota() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ rotaId }: DeleteReceptionRotaPayload) => apiClient.delete<void>(`/reception/rota/${rotaId}`),
    onSuccess: (_data, { rotaId, date }) => {
      queryClient.removeQueries({ queryKey: receptionKeys.rotaDetail(rotaId) });
      queryClient.removeQueries({ queryKey: receptionKeys.rotaByDate(date) });
    },
  });
}

/**
 * Splices a freshly written session plus recomputed issues into the
 * by-date cache - covers both create (append, no matching session_id yet)
 * and patch (replace in place) with one helper, since the response always
 * carries the full current issues list, not a delta.
 */
function applyReceptionSessionWrite(
  queryClient: ReturnType<typeof useQueryClient>,
  date: string,
  session: ReceptionRotaSession,
  issues: ValidationIssue[],
) {
  queryClient.setQueryData<ReceptionRota | undefined>(receptionKeys.rotaByDate(date), (prev) => {
    if (prev === undefined) return prev;
    const exists = prev.sessions.some((s) => s.session_id === session.session_id);
    const sessions = exists
      ? prev.sessions.map((s) => (s.session_id === session.session_id ? session : s))
      : [...prev.sessions, session];
    return { ...prev, sessions, issues };
  });
}

export interface CreateReceptionRotaSessionPayload {
  rotaId: number;
  date: string;
  staffId: number;
  hour: number;
  role?: ReceptionRole;
  note?: string | null;
}

export function useCreateReceptionRotaSession() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ rotaId, staffId, hour, role, note }: CreateReceptionRotaSessionPayload) =>
      apiClient.post<ReceptionSessionWriteOut>(`/reception/rota/${rotaId}/sessions`, {
        staff_id: staffId,
        hour,
        role: role ?? "phones",
        note: note ?? null,
      }),
    onSuccess: (data, { date }) => {
      applyReceptionSessionWrite(queryClient, date, data.session, data.issues);
    },
  });
}

export interface PatchReceptionRotaSessionPayload {
  rotaId: number;
  date: string;
  sessionId: number;
  role: ReceptionRole;
  note: string | null;
}

export function usePatchReceptionRotaSession() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ rotaId, sessionId, role, note }: PatchReceptionRotaSessionPayload) =>
      apiClient.patch<ReceptionSessionWriteOut>(`/reception/rota/${rotaId}/sessions/${sessionId}`, { role, note }),
    onSuccess: (data, { date }) => {
      applyReceptionSessionWrite(queryClient, date, data.session, data.issues);
    },
  });
}

export interface DeleteReceptionRotaSessionPayload {
  rotaId: number;
  date: string;
  sessionId: number;
}

/**
 * 204 with no body (see routers/reception_rota.py's delete_session
 * docstring) - issues need recomputing too and this is an infrequent
 * action, so this invalidates and refetches the day rather than splicing,
 * unlike create/patch above.
 */
export function useDeleteReceptionRotaSession() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ rotaId, sessionId }: DeleteReceptionRotaSessionPayload) =>
      apiClient.delete<void>(`/reception/rota/${rotaId}/sessions/${sessionId}`),
    onSuccess: (_data, { date }) => {
      queryClient.invalidateQueries({ queryKey: receptionKeys.rotaByDate(date) });
    },
  });
}

// --- Reception leave ---
// Whole-day absence. Every write invalidates the day rota queries as well
// as the leave list: leave feeds the coverage headcount and the day grid's
// greyed rows (ReceptionRotaOut.staff_on_leave), so a cached day rendered
// before the leave was recorded would otherwise keep showing the old
// numbers until something else refetched it.

export function useReceptionLeave(staffId: number | null = null) {
  return useQuery({
    queryKey: receptionKeys.leaveList(staffId),
    queryFn: () =>
      apiClient.get<ReceptionLeaveEntry[]>(
        staffId === null ? "/reception/leave" : `/reception/leave?staff_id=${staffId}`,
      ),
  });
}

function invalidateLeaveAndRotas(queryClient: ReturnType<typeof useQueryClient>) {
  queryClient.invalidateQueries({ queryKey: receptionKeys.leaveAll });
  queryClient.invalidateQueries({ queryKey: receptionKeys.rotaAll });
}

export interface CreateReceptionLeavePayload {
  staffId: number;
  date: string;
}

export function useCreateReceptionLeave() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ staffId, date }: CreateReceptionLeavePayload) =>
      apiClient.post<ReceptionLeaveEntry>("/reception/leave", { staff_id: staffId, date }),
    onSuccess: () => invalidateLeaveAndRotas(queryClient),
  });
}

export function useBulkCreateReceptionLeave() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (payload: ReceptionLeaveRangeIn) =>
      apiClient.post<ReceptionLeaveBulkOut>("/reception/leave/bulk", payload),
    onSuccess: () => invalidateLeaveAndRotas(queryClient),
  });
}

export function useBulkDeleteReceptionLeave() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (payload: ReceptionLeaveRangeIn) =>
      apiClient.post<ReceptionLeaveBulkDeleteOut>("/reception/leave/bulk-delete", payload),
    onSuccess: () => invalidateLeaveAndRotas(queryClient),
  });
}

export function useDeleteReceptionLeave() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (leaveId: number) => apiClient.delete<void>(`/reception/leave/${leaveId}`),
    onSuccess: () => invalidateLeaveAndRotas(queryClient),
  });
}

// --- Reception counters ---
// Read-only and derived server-side from reception_rota_sessions, so there
// is nothing to invalidate on write here: the counters change whenever a
// day is generated, edited or deleted, and the reception rota mutations
// above already invalidate receptionKeys.rotaAll. Add countersAll to those
// invalidations if a page ever shows counters alongside an editable day -
// useDeleteReceptionStaff already does, since a permanent purge removes a
// person from the counters window entirely rather than changing a number.

export function useReceptionCounters(
  fromDate: string | null = null,
  toDate: string | null = null,
) {
  const params = new URLSearchParams();
  if (fromDate !== null) params.set("from_date", fromDate);
  if (toDate !== null) params.set("to_date", toDate);
  const query = params.toString();
  return useQuery({
    queryKey: receptionKeys.countersList(fromDate, toDate),
    queryFn: () =>
      apiClient.get<ReceptionCounters>(
        query === "" ? "/reception/counters" : `/reception/counters?${query}`,
      ),
  });
}
