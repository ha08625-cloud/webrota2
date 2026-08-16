import { keepPreviousData, useQuery } from "@tanstack/react-query";

import { apiClient } from "./client";
import type { AuditLogFilters, AuditLogList } from "./types";

export const auditKeys = {
  all: ["audit"] as const,
  list: (filters: AuditLogFilters) => [...auditKeys.all, "list", filters] as const,
};

/**
 * The query string for GET /audit, built with URLSearchParams rather than
 * template concatenation: this endpoint takes nine parameters, all
 * optional, and hand-assembling `?a=1&b=2` with conditional ampersands is
 * where the existing single-parameter cases (`?year=${year}`) stop scaling.
 *
 * Undefined fields are omitted entirely rather than sent empty, so the
 * backend applies its own limit/offset defaults. Empty strings are dropped
 * too - a cleared filter box should mean "no filter", not "match the empty
 * string" (harmless for `path_contains`, which the backend also treats as
 * falsy, but it keeps the URL and the query key clean).
 */
function buildQuery(filters: AuditLogFilters): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(filters)) {
    if (value === undefined || value === null || value === "") {
      continue;
    }
    params.set(key, String(value));
  }
  const query = params.toString();
  return query ? `?${query}` : "";
}

/**
 * One page of the audit log. Manager-only server-side: every other tier
 * gets a 403, so callers are expected to have gated the route already.
 *
 * The filter object goes into the query key, so any change to it (a new
 * offset included) is a distinct cache entry. `placeholderData:
 * keepPreviousData` is what makes that bearable: this is the first
 * server-paginated list in the app, and without it every page change drops
 * back to `data === undefined` and flashes an empty table before the next
 * page lands. The previous page stays on screen instead, with
 * `isPlaceholderData` available to dim it or disable the pager while the
 * request is in flight. Copy this pair into any future paginated list.
 *
 * There are no mutations here - the table has no write API, and nothing in
 * the app invalidates these keys.
 */
export function useAuditLog(filters: AuditLogFilters) {
  return useQuery({
    queryKey: auditKeys.list(filters),
    queryFn: () => apiClient.get<AuditLogList>(`/audit${buildQuery(filters)}`),
    placeholderData: keepPreviousData,
  });
}
