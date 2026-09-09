import { useQuery } from "@tanstack/react-query";

import { apiClient } from "./client";
import type { Room } from "./types";

export const roomKeys = {
  all: ["rooms"] as const,
  list: () => [...roomKeys.all, "list"] as const,
};

/**
 * Rooms are read-only in M3 and still read-only in M4 (14 rows, seeded).
 * Fetched once and cached indefinitely for the session - the grid uses
 * this to map room_id -> room_type for Q13 font colouring, not for any
 * editing flow.
 */
export function useRooms() {
  return useQuery({
    queryKey: roomKeys.list(),
    queryFn: () => apiClient.get<Room[]>("/rooms"),
    staleTime: Infinity,
  });
}