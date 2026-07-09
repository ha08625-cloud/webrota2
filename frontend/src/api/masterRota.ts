import { useQuery } from "@tanstack/react-query";

import { apiClient } from "./client";
import type { MasterRotaTemplate } from "./types";

export const masterRotaKeys = {
  all: ["master-rota"] as const,
  active: () => [...masterRotaKeys.all, "active"] as const,
};

/**
 * The active master template, read-only. Template editing is a deferred
 * milestone (architecture.md, Outstanding Tasks) - this hook only ever
 * reads. 404 (no active template) surfaces via ApiError.status, handled
 * by MasterRotaPage.
 */
export function useActiveMasterRota() {
  return useQuery({
    queryKey: masterRotaKeys.active(),
    queryFn: () => apiClient.get<MasterRotaTemplate>("/master-rota/active"),
  });
}