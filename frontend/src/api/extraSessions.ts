import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { apiClient } from "./client";
import type { ExtraSessionEntry, ExtraSessionIn } from "./types";

export const extraSessionKeys = {
  all: ["extraSessions"] as const,
  list: (doctorId: number | null) => [...extraSessionKeys.all, "list", doctorId] as const,
};

/** doctorId=null means unfiltered (the "all doctors" option in the filter select), matching useLeave's convention. */
export function useExtraSessions(doctorId: number | null) {
  return useQuery({
    queryKey: extraSessionKeys.list(doctorId),
    queryFn: () =>
      apiClient.get<ExtraSessionEntry[]>(
        doctorId === null ? "/extra-sessions" : `/extra-sessions?doctor_id=${doctorId}`,
      ),
  });
}

/**
 * Unlike useCreateLeave/useDeleteLeave, neither mutation here invalidates
 * rotaKeys. An extra session is only ever read once, at POST /staging
 * creation time - it never mutates a draft or the active staging
 * directly, so there is nothing for an open rota or staging view to
 * refetch as a result of this mutation.
 */
export function useCreateExtraSession() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (payload: ExtraSessionIn) =>
      apiClient.post<ExtraSessionEntry>("/extra-sessions", payload),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: extraSessionKeys.all });
    },
  });
}

export function useDeleteExtraSession() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: number) => apiClient.delete<void>(`/extra-sessions/${id}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: extraSessionKeys.all });
    },
  });
}