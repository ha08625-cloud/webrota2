import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { apiClient } from "./client";
import type { SignatureMeta } from "./types";

export const signatureKeys = {
  all: ["signatures"] as const,
  list: () => [...signatureKeys.all, "list"] as const,
  image: (doctorId: number) => [...signatureKeys.all, doctorId, "image"] as const,
};

/** GET /signatures - the full metadata list; consumers derive a Map<doctorId, SignatureMeta>. */
export function useSignatures() {
  return useQuery({
    queryKey: signatureKeys.list(),
    queryFn: () => apiClient.get<SignatureMeta[]>("/signatures"),
  });
}

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(reader.error ?? new Error("Failed to read signature image"));
    reader.readAsDataURL(blob);
  });
}

/**
 * GET /signatures/{doctorId}/image, converted to a data URL. Data URLs
 * sidestep the object-URL revoke lifecycle entirely - signature images are
 * small, so the one-time base64 conversion cost is not worth managing
 * revocation for. `enabled` lets callers gate the fetch on the doctor
 * actually having a stored signature (per useSignatures) rather than
 * firing an image request that 404s.
 */
export function useSignatureImage(doctorId: number, enabled: boolean) {
  return useQuery({
    queryKey: signatureKeys.image(doctorId),
    queryFn: async () => {
      const blob = await apiClient.getBlob(`/signatures/${doctorId}/image`);
      return blobToDataUrl(blob);
    },
    enabled,
  });
}

export interface UploadSignaturePayload {
  doctorId: number;
  file: File;
}

/**
 * POST /signatures/{doctorId} (multipart). Invalidates the whole
 * signatures root on success, not just the list - that also picks up the
 * per-doctor image query, so a re-upload refreshes the preview without a
 * separate cache-busting scheme.
 */
export function useUploadSignature() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ doctorId, file }: UploadSignaturePayload) => {
      const formData = new FormData();
      formData.append("file", file);
      return apiClient.postForm<SignatureMeta>(`/signatures/${doctorId}`, formData);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: signatureKeys.all });
    },
  });
}

/** DELETE /signatures/{doctorId} - 204, no body. */
export function useDeleteSignature() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (doctorId: number) => apiClient.delete<void>(`/signatures/${doctorId}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: signatureKeys.all });
    },
  });
}

export interface ApplySignaturePayload {
  doctorId: number;
  file: File;
}

/**
 * POST /signatures/{doctorId}/apply (multipart in, docx blob out). Nothing
 * server-side changes as a result, so there is no cache to invalidate -
 * the caller (SignaturesPage, Task 5) is responsible for triggering the
 * browser download from the resolved blob/filename.
 */
export function useApplySignature() {
  return useMutation({
    mutationFn: ({ doctorId, file }: ApplySignaturePayload) => {
      const formData = new FormData();
      formData.append("file", file);
      return apiClient.postFormBlob(`/signatures/${doctorId}/apply`, formData);
    },
  });
}
