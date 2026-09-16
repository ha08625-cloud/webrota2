import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { apiClient } from "./client";
import { leaveKeys } from "./leave";
import type { ExtraSessionCompensation, ExtraSessionEntry, ExtraSessionIn } from "./types";

export const extraSessionKeys = {
  all: ["extraSessions"] as const,
  list: (doctorId: number | null, year: number | null) =>
    [...extraSessionKeys.all, "list", doctorId, year] as const,
};

/**
 * Entries in one calendar year - the year shared by the Session Management
 * tabs, see SessionManagementTabs.tsx - or, with year=null, every entry
 * regardless of date. Either argument being null means "unfiltered on that
 * axis", matching useLeave's convention for doctorId.
 */
export function useExtraSessions(doctorId: number | null, year: number | null) {
  return useQuery({
    queryKey: extraSessionKeys.list(doctorId, year),
    queryFn: () => {
      const params = new URLSearchParams();
      if (doctorId !== null) params.set("doctor_id", String(doctorId));
      if (year !== null) {
        params.set("from_date", `${year}-01-01`);
        params.set("to_date", `${year}-12-31`);
      }
      const query = params.toString();
      return apiClient.get<ExtraSessionEntry[]>(
        query ? `/extra-sessions?${query}` : "/extra-sessions",
      );
    },
  });
}

/**
 * Every leave-entitlement query, whatever year. A TOIL extra session
 * credits +1 session to the balance for the year it falls in, counted at
 * read time from `extra_session_entries`, so creating, deleting or
 * re-compensating one moves a figure that lives under `leaveKeys` - and
 * on the Individual Leave tab that figure is rendered beside the list
 * being edited. A prefix of `leaveKeys.entitlement(year)` rather than
 * `leaveKeys.all`, because the leave *list* is not affected by any of
 * these.
 */
const entitlementKeyPrefix = [...leaveKeys.all, "entitlement"] as const;

/**
 * None of the three mutations here invalidates rotaKeys, unlike
 * useCreateLeave/useDeleteLeave. An extra session is only ever read once,
 * at POST /staging creation time - it never mutates a draft or the active
 * staging directly, so there is nothing for an open rota or staging view
 * to refetch as a result of this mutation.
 *
 * They do all invalidate the entitlement query, for the reason above.
 */
export function useCreateExtraSession() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (payload: ExtraSessionIn) =>
      apiClient.post<ExtraSessionEntry>("/extra-sessions", payload),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: extraSessionKeys.all });
      queryClient.invalidateQueries({ queryKey: entitlementKeyPrefix });
    },
  });
}

/**
 * Correct an existing session's compensation. Compensation is the only
 * editable field: moving a session to another date, period or doctor is
 * still delete-and-recreate, since it lands the row in a different slot
 * with its own uniqueness and validation.
 *
 * A TOIL session for a doctor type with no leave entitlement is refused by
 * the server with a 422, which callers should surface verbatim.
 */
export function useUpdateExtraSession() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      id,
      compensation,
    }: {
      id: number;
      compensation: ExtraSessionCompensation;
    }) => apiClient.patch<ExtraSessionEntry>(`/extra-sessions/${id}`, { compensation }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: extraSessionKeys.all });
      queryClient.invalidateQueries({ queryKey: entitlementKeyPrefix });
    },
  });
}

export function useDeleteExtraSession() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: number) => apiClient.delete<void>(`/extra-sessions/${id}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: extraSessionKeys.all });
      queryClient.invalidateQueries({ queryKey: entitlementKeyPrefix });
    },
  });
}