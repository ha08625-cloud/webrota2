import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { apiClient } from "@/api/client";
import { downloadBlob } from "@/lib/downloadBlob";

import type { SetupStepPatch, Study, StudyDocument, StudyIn, StudyPatch } from "./types";

/**
 * TanStack Query hooks for the Research section.
 *
 * The section owns its own hooks (`features/research/api.ts`) rather than
 * adding a module to the flat `src/api/` tree - see "Adding a Module" in
 * `documentation/architecture.md`. It still imports the shared
 * `api/client.ts` and `lib/downloadBlob.ts`: those are shared
 * infrastructure, not another section's code.
 *
 * **Every mutation invalidates the resource root, not one key.** Almost
 * every write here returns the whole study (a setup-step PATCH and a
 * stage transition both do), and several change the list as well as the
 * detail - a rename moves a row, a transition moves it between groups.
 * Invalidating `studyKeys.all` is one line that is right for all of them,
 * against a resource the app fetches wholesale anyway.
 */
export const studyKeys = {
  all: ["research", "studies"] as const,
  list: () => [...studyKeys.all, "list"] as const,
  detail: (id: number) => [...studyKeys.all, "detail", id] as const,
};

export function useStudies() {
  return useQuery({
    queryKey: studyKeys.list(),
    queryFn: () => apiClient.get<Study[]>("/research/studies"),
  });
}

export function useStudy(studyId: number | null) {
  return useQuery({
    queryKey: studyKeys.detail(studyId ?? 0),
    queryFn: () => apiClient.get<Study>(`/research/studies/${studyId}`),
    enabled: studyId !== null,
  });
}

export function useCreateStudy() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (payload: StudyIn) => apiClient.post<Study>("/research/studies", payload),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: studyKeys.all });
    },
  });
}

export interface UpdateStudyPayload {
  studyId: number;
  payload: StudyPatch;
}

export function useUpdateStudy() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ studyId, payload }: UpdateStudyPayload) =>
      apiClient.patch<Study>(`/research/studies/${studyId}`, payload),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: studyKeys.all });
    },
  });
}

/** Setup only - the server answers 409 once a study has ever recruited. */
export function useDeleteStudy() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (studyId: number) => apiClient.delete<void>(`/research/studies/${studyId}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: studyKeys.all });
    },
  });
}

/**
 * One stage forward or one stage back. Two hooks over two endpoints
 * rather than one taking a direction, mirroring the API: the transition
 * is the domain action, and the two have different confirmation copy and
 * different audit sentences behind them.
 */
export function useAdvanceStudy() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (studyId: number) =>
      apiClient.post<Study>(`/research/studies/${studyId}/advance`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: studyKeys.all });
    },
  });
}

export function useRevertStudy() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (studyId: number) =>
      apiClient.post<Study>(`/research/studies/${studyId}/revert`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: studyKeys.all });
    },
  });
}

export interface UpdateSetupStepPayload {
  studyId: number;
  stepKey: string;
  payload: SetupStepPatch;
}

/** The row is created by the first write to it; there is no "add step". */
export function useUpdateSetupStep() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ studyId, stepKey, payload }: UpdateSetupStepPayload) =>
      apiClient.patch<Study>(
        `/research/studies/${studyId}/setup-steps/${stepKey}`,
        payload,
      ),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: studyKeys.all });
    },
  });
}

export interface UploadStudyDocumentPayload {
  studyId: number;
  slot: string;
  file: File;
}

/**
 * Uploading to a key slot replaces whatever is there, in one server-side
 * transaction. The caller is responsible for confirming that first - the
 * hook cannot know whether the slot was occupied without the study, and
 * the page already holds it.
 */
export function useUploadStudyDocument() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ studyId, slot, file }: UploadStudyDocumentPayload) => {
      const formData = new FormData();
      formData.append("slot", slot);
      formData.append("file", file);
      return apiClient.postForm<StudyDocument>(
        `/research/studies/${studyId}/documents`,
        formData,
      );
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: studyKeys.all });
    },
  });
}

export interface DeleteStudyDocumentPayload {
  studyId: number;
  documentId: number;
}

export function useDeleteStudyDocument() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ studyId, documentId }: DeleteStudyDocumentPayload) =>
      apiClient.delete<void>(`/research/studies/${studyId}/documents/${documentId}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: studyKeys.all });
    },
  });
}

export interface DownloadStudyDocumentPayload {
  studyId: number;
  document: StudyDocument;
}

/**
 * A mutation rather than a query: a download is an action the user takes,
 * not state the page holds, and caching the bytes of a file that was
 * fetched once to be saved to disk would be a straightforward waste.
 *
 * `getBlob` discards the response headers, so the filename comes from the
 * document row the page already has rather than from Content-Disposition.
 * The server sends the same name, sanitised; if the two ever disagree the
 * saved file is named after what the page showed, which is the one the
 * user chose to download.
 */
export function useDownloadStudyDocument() {
  return useMutation({
    mutationFn: async ({ studyId, document }: DownloadStudyDocumentPayload) => {
      const blob = await apiClient.getBlob(
        `/research/studies/${studyId}/documents/${document.id}`,
      );
      downloadBlob(blob, document.filename);
    },
  });
}
