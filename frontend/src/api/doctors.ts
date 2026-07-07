import { useQuery } from "@tanstack/react-query";

import { apiClient } from "./client";
import type { Doctor } from "./types";

export const doctorKeys = {
  all: ["doctors"] as const,
  list: (activeOnly: boolean) => [...doctorKeys.all, "list", activeOnly] as const,
};

/**
 * Read-only list fetch only, not present before this task (DoctorsPage is
 * still a stub pending Task 6). The grid needs the *full* list
 * (active_only=false), not the default active-only one: per the M4 spec,
 * rows are active doctors plus any inactive doctor who has sessions in
 * the viewed rota, flagged - which requires knowing about inactive
 * doctors at all. Create/edit/soft-delete and the preferred-room editor
 * belong to Task 6.
 */
export function useDoctors(activeOnly = false) {
  return useQuery({
    queryKey: doctorKeys.list(activeOnly),
    queryFn: () => apiClient.get<Doctor[]>(`/doctors?active_only=${activeOnly}`),
  });
}