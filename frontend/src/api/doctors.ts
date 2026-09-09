import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { apiClient } from "./client";
import type {
  Doctor,
  DoctorDeleteResult,
  DoctorDetail,
  DoctorIn,
  DoctorPatch,
  DoctorUsage,
  PreferredRoomIn,
} from "./types";

export const doctorKeys = {
  all: ["doctors"] as const,
  list: (activeOnly: boolean) => [...doctorKeys.all, "list", activeOnly] as const,
  detail: (id: number) => [...doctorKeys.all, "detail", id] as const,
  usage: (id: number) => [...doctorKeys.all, "usage", id] as const,
};

/**
 * The grid needs the *full* list (active_only=false), not the default
 * active-only one: per the M4 spec, rows are active doctors plus any
 * inactive doctor who has sessions in the viewed rota, flagged - which
 * requires knowing about inactive doctors at all. DoctorsPage (Task 6)
 * calls this with `true` for its active-only management table.
 */
export function useDoctors(activeOnly = false) {
  return useQuery({
    queryKey: doctorKeys.list(activeOnly),
    queryFn: () => apiClient.get<Doctor[]>(`/doctors?active_only=${activeOnly}`),
  });
}

/**
 * GET /doctors/{id} - the list endpoint's DoctorOut has no
 * preferred_rooms, so editing a doctor (which needs them) requires this
 * separate detail fetch. Only enabled when an id is supplied, so
 * DoctorFormDialog can call this unconditionally and let `enabled` gate
 * create-mode away rather than branching the hook call itself.
 */
export function useDoctor(id: number | undefined) {
  return useQuery({
    queryKey: doctorKeys.detail(id ?? -1),
    queryFn: () => apiClient.get<DoctorDetail>(`/doctors/${id}`),
    enabled: id !== undefined,
  });
}

/**
 * Create/update/delete all invalidate the doctors lists on success,
 * rather than splicing the response in directly - same rationale as
 * Task 5's clinicTypes.ts: this list is small and nobody is mid-gesture
 * when these mutations fire, so a plain refetch is simpler and just as
 * correct. Invalidating `doctorKeys.all` covers both the active-only and
 * active_only=false list variants without needing to know which are
 * currently mounted.
 */
export function useCreateDoctor() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (payload: DoctorIn) => apiClient.post<Doctor>("/doctors", payload),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: doctorKeys.all });
    },
  });
}

export interface UpdateDoctorPayload {
  id: number;
  payload: DoctorPatch;
}

export function useUpdateDoctor() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, payload }: UpdateDoctorPayload) =>
      apiClient.patch<Doctor>(`/doctors/${id}`, payload),
    onSuccess: (_data, variables) => {
      queryClient.invalidateQueries({ queryKey: doctorKeys.all });
      queryClient.invalidateQueries({ queryKey: doctorKeys.detail(variables.id) });
    },
  });
}

/**
 * GET /doctors/{id}/usage - what a permanent delete would destroy, read by
 * the confirm dialog. Null id disables the query, so the dialog can call
 * this unconditionally and let `enabled` gate the closed state away, the
 * same shape useReceptionStaffUsage uses.
 */
export function useDoctorUsage(id: number | null) {
  return useQuery({
    queryKey: doctorKeys.usage(id ?? 0),
    queryFn: () => apiClient.get<DoctorUsage>(`/doctors/${id}/usage`),
    enabled: id !== null,
  });
}

/**
 * DELETE /doctors/{id} - a permanent purge, NOT a deactivate. Deactivation
 * is useUpdateDoctor with {active: false}; this removes the doctor row and
 * every row referencing it, and 409s unless the doctor is already inactive
 * (see routers/doctors.py).
 *
 * Invalidates the ENTIRE query cache rather than a list of roots. A doctor
 * is referenced by eighteen tables, so the purge reaches the rota grids,
 * the staging grid, the master template, leave, leave planning, duty,
 * extra sessions, blocked slots, counters, recurring-note pickers,
 * signatures and the user list - naming those roots here would be a second
 * copy of PURGED_MODELS that goes stale silently the first time one is
 * missed. This fires at most a handful of times in the app's life, and
 * everything it refetches is small.
 */
export function useDeleteDoctor() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: number) => apiClient.delete<DoctorDeleteResult>(`/doctors/${id}`),
    onSuccess: () => {
      queryClient.invalidateQueries();
    },
  });
}

export interface ReplacePreferredRoomsPayload {
  doctorId: number;
  rows: PreferredRoomIn[];
}

/** PUT /doctors/{id}/preferred-rooms - replace-all pattern, returns DoctorDetailOut. */
export function useReplacePreferredRooms() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ doctorId, rows }: ReplacePreferredRoomsPayload) =>
      apiClient.put<DoctorDetail>(`/doctors/${doctorId}/preferred-rooms`, rows),
    onSuccess: (_data, variables) => {
      queryClient.invalidateQueries({ queryKey: doctorKeys.detail(variables.doctorId) });
    },
  });
}