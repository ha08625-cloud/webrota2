import { useMutation } from "@tanstack/react-query";

import { apiClient } from "./client";

/**
 * Rule id -> human label, for the "these sections were not filled in"
 * warning. The endpoint reports misses as ids (POST /eoi/fill's
 * X-EOI-Unmatched header) because header values are latin-1 and
 * comma-separated, so the labels live here on the display side.
 *
 * MUST stay in step with backend/app/documents/eoi_rules.py - an id added
 * or renamed there needs the matching entry here, or the warning falls
 * back to showing the bare id.
 */
export const EOI_SECTION_LABELS: Record<string, string> = {
  "section-1": "Research site",
  "section-2": "Investigator",
  "section-3": "Main contact for feasibility discussions",
  "section-4": "Research setting",
  "section-5": "Supporting Network",
  "section-6": "Participant recruitment",
  "section-7": "Staff resource",
  "section-8": "Infrastructure",
  "section-9": "Site-specific activities",
  "section-10": "Non-commercial studies",
  "section-11": "Network support",
};

/** Falls back to the raw id so an unmapped rule is still named, not swallowed. */
export function eoiSectionLabel(id: string): string {
  return EOI_SECTION_LABELS[id] ?? id;
}

/**
 * Parses X-EOI-Unmatched into the ids of the rules that found no target.
 *
 * The header is always sent, and is the empty string when every rule
 * matched. A *missing* header would mean the browser could not see it -
 * which, with the backend's CORS expose_headers listing it, should not
 * happen; either way the honest reading is "no information", so it is
 * treated as no misses rather than warned about.
 */
export function parseUnmatched(headers: Headers): string[] {
  const raw = headers.get("X-EOI-Unmatched");
  if (!raw) {
    return [];
  }
  return raw
    .split(",")
    .map((id) => id.trim())
    .filter((id) => id.length > 0);
}

export interface FillEoiResult {
  blob: Blob;
  filename: string | null;
  unmatched: string[];
}

/**
 * POST /eoi/fill (multipart in, docx blob out). Nothing is persisted
 * server-side, so there is no cache to invalidate - the caller triggers
 * the download from the resolved blob/filename and surfaces `unmatched`.
 */
export function useFillEoi() {
  return useMutation({
    mutationFn: async (file: File): Promise<FillEoiResult> => {
      const formData = new FormData();
      formData.append("file", file);
      const { blob, filename, headers } = await apiClient.postFormBlob("/eoi/fill", formData);
      return { blob, filename, unmatched: parseUnmatched(headers) };
    },
  });
}
