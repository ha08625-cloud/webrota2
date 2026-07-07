import { useQuery } from "@tanstack/react-query";

import { apiClient } from "./client";
import type { ClinicType } from "./types";

export const clinicTypeKeys = {
  all: ["clinicTypes"] as const,
  list: () => [...clinicTypeKeys.all, "list"] as const,
};

/**
 * Read-only list fetch only. Task 3 needs this for the grid's
 * clinic_type_id -> category lookup (duty helper vs named clinic colour,
 * see cellStyle.ts). Create/edit/delete and the nested form belong to
 * Task 5 - this hook will very likely gain sibling mutations there, not
 * be replaced.
 */
export function useClinicTypes() {
  return useQuery({
    queryKey: clinicTypeKeys.list(),
    queryFn: () => apiClient.get<ClinicType[]>("/clinic-types"),
  });
}