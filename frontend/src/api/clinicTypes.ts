import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { apiClient } from "./client";
import type { ClinicType, ClinicTypeIn } from "./types";

export const clinicTypeKeys = {
  all: ["clinicTypes"] as const,
  list: () => [...clinicTypeKeys.all, "list"] as const,
};

export function useClinicTypes() {
  return useQuery({
    queryKey: clinicTypeKeys.list(),
    queryFn: () => apiClient.get<ClinicType[]>("/clinic-types"),
  });
}

/**
 * Create/update/delete all just invalidate the list on success, rather
 * than splicing the response in directly (contrast Task 4's rota session
 * mutations, which splice to avoid disrupting an in-progress drag). The
 * clinic-types list is small and nobody is mid-gesture when this form
 * submits, so a plain refetch is simpler and just as correct.
 */
export function useCreateClinicType() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (payload: ClinicTypeIn) => apiClient.post<ClinicType>("/clinic-types", payload),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: clinicTypeKeys.list() });
    },
  });
}

export interface UpdateClinicTypePayload {
  id: number;
  payload: ClinicTypeIn;
}

export function useUpdateClinicType() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, payload }: UpdateClinicTypePayload) =>
      apiClient.put<ClinicType>(`/clinic-types/${id}`, payload),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: clinicTypeKeys.list() });
    },
  });
}

export function useDeleteClinicType() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: number) => apiClient.delete<void>(`/clinic-types/${id}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: clinicTypeKeys.list() });
    },
  });
}