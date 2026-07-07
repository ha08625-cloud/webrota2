import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { apiClient } from "./client";
import type { GenerateRotaIn, GenerateRotaOut, Rota, RotaSummary } from "./types";

export const rotaKeys = {
  all: ["rota"] as const,
  list: () => [...rotaKeys.all, "list"] as const,
  detail: (rotaId: number) => [...rotaKeys.all, "detail", rotaId] as const,
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
      // Commit returns the full RotaOut - seed the detail cache with it
      // rather than discarding it, so re-opening this rota from the
      // committed history list is instant instead of an avoidable refetch.
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
      // The rota no longer exists - drop its cache entry outright rather
      // than leaving it to be refetched into a 404 later.
      queryClient.removeQueries({ queryKey: rotaKeys.detail(rotaId) });
      queryClient.invalidateQueries({ queryKey: rotaKeys.list() });
    },
  });
}