import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { apiClient } from "./client";
import type { School, SchoolHoliday, SchoolHolidayIn, SchoolIn } from "./types";

export const schoolKeys = {
  all: ["schools"] as const,
  list: () => [...schoolKeys.all, "list"] as const,
};

/**
 * Unfiltered, mirroring useClosures(null): a handful of schools and holidays
 * per year, each school returned with its holidays nested - both the
 * School Holidays page and the Annual Planner filter down to what they
 * need client-side rather than the API taking a date-range query param.
 */
export function useSchools() {
  return useQuery({
    queryKey: schoolKeys.list(),
    queryFn: () => apiClient.get<School[]>("/schools"),
  });
}

export function useCreateSchool() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (payload: SchoolIn) => apiClient.post<School>("/schools", payload),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: schoolKeys.all });
    },
  });
}

export function useRenameSchool() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, payload }: { id: number; payload: SchoolIn }) =>
      apiClient.patch<School>(`/schools/${id}`, payload),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: schoolKeys.all });
    },
  });
}

export function useDeleteSchool() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: number) => apiClient.delete<void>(`/schools/${id}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: schoolKeys.all });
    },
  });
}

export function useCreateHoliday() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ schoolId, payload }: { schoolId: number; payload: SchoolHolidayIn }) =>
      apiClient.post<SchoolHoliday>(`/schools/${schoolId}/holidays`, payload),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: schoolKeys.all });
    },
  });
}

export function useUpdateHoliday() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      schoolId,
      holidayId,
      payload,
    }: {
      schoolId: number;
      holidayId: number;
      payload: SchoolHolidayIn;
    }) => apiClient.patch<SchoolHoliday>(`/schools/${schoolId}/holidays/${holidayId}`, payload),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: schoolKeys.all });
    },
  });
}

export function useDeleteHoliday() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ schoolId, holidayId }: { schoolId: number; holidayId: number }) =>
      apiClient.delete<void>(`/schools/${schoolId}/holidays/${holidayId}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: schoolKeys.all });
    },
  });
}
