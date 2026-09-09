import { useMutation, useQueryClient } from "@tanstack/react-query";

import { apiClient } from "./client";
import { stagingKeys } from "./staging";
import type { Staging, StagingNoteIn, StagingNotePatchIn } from "./types";

/**
 * Per-run note instances, written under /staging/{id}/notes so they
 * inherit the staging router's active-staging guard, but stored against
 * the staging's RotaConfig (see routers/staging.py).
 *
 * There is no list hook: the instances arrive on StagingOut.notes with
 * the staging itself, so `useActiveStaging` is the only read path.
 *
 * POST and PATCH both return the whole StagingOut, so their results are
 * written straight into the active-staging cache rather than
 * invalidating it - the response is already the authoritative post-write
 * state, and a refetch would only repeat it. DELETE has no body, so it
 * filters the removed note out of the cached staging, the same
 * splice-in-place shape staging.ts uses for session deletes.
 */

function setActiveStaging(
  queryClient: ReturnType<typeof useQueryClient>,
  staging: Staging,
): void {
  queryClient.setQueryData<Staging | null>(stagingKeys.active(), staging);
}

export interface CreateStagingNotePayload {
  stagingId: number;
  payload: StagingNoteIn;
}

export function useCreateStagingNote() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ stagingId, payload }: CreateStagingNotePayload) =>
      apiClient.post<Staging>(`/staging/${stagingId}/notes`, payload),
    onSuccess: (data) => setActiveStaging(queryClient, data),
  });
}

export interface UpdateStagingNotePayload {
  stagingId: number;
  noteId: number;
  payload: StagingNotePatchIn;
}

export function useUpdateStagingNote() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ stagingId, noteId, payload }: UpdateStagingNotePayload) =>
      apiClient.patch<Staging>(`/staging/${stagingId}/notes/${noteId}`, payload),
    onSuccess: (data) => setActiveStaging(queryClient, data),
  });
}

export interface DeleteStagingNotePayload {
  stagingId: number;
  noteId: number;
}

export function useDeleteStagingNote() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ stagingId, noteId }: DeleteStagingNotePayload) =>
      apiClient.delete<void>(`/staging/${stagingId}/notes/${noteId}`),
    onSuccess: (_data, { noteId }) => {
      queryClient.setQueryData<Staging | null | undefined>(stagingKeys.active(), (prev) => {
        if (prev === undefined || prev === null) return prev;
        return { ...prev, notes: prev.notes.filter((n) => n.id !== noteId) };
      });
    },
  });
}
