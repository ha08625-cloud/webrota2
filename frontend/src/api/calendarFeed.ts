import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { apiClient } from "./client";
import type { CalendarFeed } from "./types";

export const calendarFeedKeys = {
  all: ["calendarFeed"] as const,
  detail: (doctorId: number) => [...calendarFeedKeys.all, "detail", doctorId] as const,
};

/**
 * GET /doctors/{id}/calendar-feed - the doctor's feed token and the
 * app-relative path that serves it. Readable at every access tier: the
 * feed is identified by its token, not by who is logged in.
 *
 * The token is deliberately absent from DoctorOut, so it only ever
 * arrives through this dedicated query and never rides along in the
 * doctor lists the rest of the app caches. `enabled` gates the fetch on a
 * doctor actually being picked, so CalendarFeedPage can call this
 * unconditionally rather than branching the hook call itself.
 *
 * This hook is a plain wire mirror: it returns the path exactly as the
 * server sent it. Composing the absolute URL is the component's job -
 * only the browser knows the origin it is really talking to.
 */
export function useCalendarFeed(doctorId: number | undefined) {
  return useQuery({
    queryKey: calendarFeedKeys.detail(doctorId ?? -1),
    queryFn: () => apiClient.get<CalendarFeed>(`/doctors/${doctorId}/calendar-feed`),
    enabled: doctorId !== undefined,
  });
}

/**
 * POST /doctors/{id}/calendar-feed/rotate - issue a fresh token, which
 * immediately dead-ends the old URL. Manager-only server-side.
 *
 * Invalidates rather than splices the response in: this is reference
 * data, nobody is mid-gesture when it fires, and a refetch is simpler and
 * just as correct - the same rationale as doctors.ts's mutations.
 */
export function useRotateCalendarFeed() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (doctorId: number) =>
      apiClient.post<CalendarFeed>(`/doctors/${doctorId}/calendar-feed/rotate`),
    onSuccess: (_data, doctorId) => {
      queryClient.invalidateQueries({ queryKey: calendarFeedKeys.detail(doctorId) });
    },
  });
}
