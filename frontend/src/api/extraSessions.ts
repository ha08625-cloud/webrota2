import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { apiClient } from "./client";
import type { ExtraSessionEntry, ExtraSessionIn } from "./types";

export const extraSessionKeys = {
  all: ["extraSessions"] as const,
  list: (doctorId: number | null, year: number | null) =>
    [...extraSessionKeys.all, "list", doctorId, year] as const,
};

/**
 * Entries in one calendar year - the year shared by the Session Management
 * tabs, see SessionManagementTabs.tsx - or, with year=null, every entry
 * regardless of date. Either argument being null means "unfiltered on that
 * axis", matching useLeave's convention for doctorId.
 */
export function useExtraSessions(doctorId: number | null, year: number | null) {
  return useQuery({
    queryKey: extraSessionKeys.list(doctorId, year),
    queryFn: () => {
      const params = new URLSearchParams();
      if (doctorId !== null) params.set("doctor_id", String(doctorId));
      if (year !== null) {
        params.set("from_date", `${year}-01-01`);
        params.set("to_date", `${year}-12-31`);
      }
      const query = params.toString();
      return apiClient.get<ExtraSessionEntry[]>(
        query ? `/extra-sessions?${query}` : "/extra-sessions",
      );
    },
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