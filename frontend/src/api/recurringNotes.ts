import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { apiClient } from "./client";
import type { RecurringNote, RecurringNoteIn } from "./types";

export const recurringNoteKeys = {
  all: ["recurring-notes"] as const,
  list: () => [...recurringNoteKeys.all, "list"] as const,
};

export function useRecurringNotes() {
  return useQuery({
    queryKey: recurringNoteKeys.list(),
    queryFn: () => apiClient.get<RecurringNote[]>("/recurring-notes"),
  });
}

export function useCreateRecurringNote() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (payload: RecurringNoteIn) => apiClient.post<RecurringNote>("/recurring-notes", payload),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: recurringNoteKeys.all });
    },
  });
}

export interface UpdateRecurringNotePayload {
  id: number;
  payload: RecurringNoteIn;
}

export function useUpdateRecurringNote() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, payload }: UpdateRecurringNotePayload) =>
      apiClient.put<RecurringNote>(`/recurring-notes/${id}`, payload),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: recurringNoteKeys.all });
    },
  });
}

export function useDeleteRecurringNote() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: number) => apiClient.delete<void>(`/recurring-notes/${id}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: recurringNoteKeys.all });
    },
  });
}
