import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { apiClient } from "./client";
import type { ApiError, GenerateRotaIn, GenerateRotaOut, Rota, RotaSummary } from "./types";

export const rotaKeys = {
  all: ["rota"] as const,
  list: () => [...rotaKeys.all, "list"] as const,
  detail: (rotaId: number) => [...rotaKeys.all, "detail", rotaId] as const,
};

export function useRotaList() {
  // TanStack Query defaults its error type parameter to `Error`. apiClient
  // throws a plain ApiError object literal, not an Error instance, so that
  // default is simply wrong here - stating it explicitly (rather than
  // casting `.error` at each call site) makes every consumer of this hook
  // get the real type with no cast needed.
  return useQuery<RotaSummary[], ApiError>({
    queryKey: rotaKeys.list(),
    queryFn: () => apiClient.get<RotaSummary[]>("/rota"),
  });
}

export function useRota(rotaId: number) {
  return useQuery<Rota, ApiError>({
    queryKey: rotaKeys.detail(rotaId),
    queryFn: () => apiClient.get<Rota>(`/rota/${rotaId}`),
    enabled: Number.isFinite(rotaId),
  });
}

export function useGenerateRota() {
  const queryClient = useQueryClient();
  return useMutation<GenerateRotaOut, ApiError, GenerateRotaIn>({
    mutationFn: (payload) => apiClient.post<GenerateRotaOut>("/rota/generate", payload),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: rotaKeys.list() });
    },
  });
}

export function useCommitRota() {
  const queryClient = useQueryClient();
  return useMutation<Rota, ApiError, number>({
    mutationFn: (rotaId) => apiClient.post<Rota>(`/rota/${rotaId}/commit`),
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
  return useMutation<void, ApiError, number>({
    mutationFn: (rotaId) => apiClient.delete<void>(`/rota/${rotaId}`),
    onSuccess: (_data, rotaId) => {
      // The rota no longer exists - drop its cache entry outright rather
      // than leaving it to be refetched into a 404 later.
      queryClient.removeQueries({ queryKey: rotaKeys.detail(rotaId) });
      queryClient.invalidateQueries({ queryKey: rotaKeys.list() });
    },
  });
}