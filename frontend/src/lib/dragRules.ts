import type { RotaSession } from "@/api/types";

export type ChipType = "role" | "room";

/**
 * A role chip may drop on any normal (present, non-leave, non-WFH) cell
 * for the *same day and period*. Week equality is guaranteed by
 * construction - only the active week's cells are ever mounted in the
 * DOM, so a cross-week drop can't physically be constructed - but day
 * and period are NOT guaranteed: all ten (day, period) columns of the
 * active week are mounted simultaneously, so this must be checked here
 * explicitly, not assumed.
 */
export function canDropRole(source: RotaSession, target: RotaSession | undefined): boolean {
  if (target === undefined) return false;
  if (source.day !== target.day || source.period !== target.period) return false;
  return !target.is_on_leave && !target.is_wfh;
}

/**
 * A room chip may drop on any normal cell in the same day and period (a
 * room is occupied per week/day/period; cross-slot room moves are
 * meaningless). Currently identical to canDropRole's eligibility shape,
 * kept as a separate function rather than a shared alias so a future
 * divergence (e.g. a room-only constraint) doesn't require re-threading
 * a merged function apart again.
 */
export function canDropRoom(source: RotaSession, target: RotaSession | undefined): boolean {
  if (target === undefined) return false;
  if (source.day !== target.day || source.period !== target.period) return false;
  return !target.is_on_leave && !target.is_wfh;
}

export function canDrop(type: ChipType, source: RotaSession, target: RotaSession | undefined): boolean {
  return type === "role" ? canDropRole(source, target) : canDropRoom(source, target);
}

/**
 * Both-empty is not a case either function needs to guard against: a
 * chip is only ever rendered as draggable when its own value (role or
 * room) is present (see RotaGrid), so "neither side has a value" can't
 * be constructed from a real drag. The 422 "nothing to swap or move" on
 * the backend is a defensive backstop for a malformed direct API call,
 * not a state reachable through this UI - don't add a redundant check
 * here for it.
 */