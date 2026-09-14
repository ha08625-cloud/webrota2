import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { apiClient } from "./client";
import type { ApiError } from "./types";

/**
 * The section editing lock, client side (backend: api/routers/locks.py).
 *
 * Two locks exist at most - one for `clinical`, one for `reception` - and
 * the model is a Word document on a shared drive: the first login with
 * write access to enter a section holds it, everyone else is downgraded to
 * read-only there until it is released. Reading is never blocked.
 *
 * This module is transport only. The lock is turned into "may I write
 * here, right now" by EditLockProvider in auth/AuthContext.tsx, which is
 * where every existing write-gated control inherits it without being
 * touched.
 */

/**
 * The areas a lock can be held on - backend LOCKABLE_AREAS
 * (models/permissions.py). There is no codegen between the two, so this is
 * a second literal of the same tuple; locks.test.tsx pins the strings and
 * the backend asserts its own half at import.
 *
 * Deliberately not `PermissionArea`: being locked out means being
 * downgraded to read-only, and only a levelled permission has a read level
 * to be downgraded to. The boolean areas (signatures, study_eoi,
 * user_admin) cannot be locked, and this type is what stops a caller
 * asking for a lock on one.
 */
export const LOCKABLE_AREAS = ["clinical", "reception"] as const;

export type LockableArea = (typeof LOCKABLE_AREAS)[number];

/** One row of GET /locks (backend schemas/edit_lock.py: EditLockOut). */
export interface EditLock {
  area: LockableArea;
  user_id: number;
  user_name: string;
  acquired_at: string;
  last_activity_at: string;
  /**
   * True when the lock has gone the backend's idle timeout without an edit
   * and is therefore takeable by the next person who asks. NOT a promise
   * that it has been released - nothing sweeps a stale row - so a caller
   * deciding whether it may write must read this as "the server would let
   * me take this one", which is exactly what require_edit_lock does.
   */
  idle: boolean;
}

export const lockKeys = {
  all: ["locks"] as const,
  list: () => [...lockKeys.all, "list"] as const,
  /**
   * The mutation key both writes below carry. It exists so the shared
   * lock-409 handler in EditLockProvider can tell the lock's OWN calls
   * apart from every other mutation in the app: a 409 from the acquire is
   * the entry dialog's business and must not also raise the mid-session
   * "you have just lost the lock" notice.
   */
  mutations: () => [...lockKeys.all, "mutation"] as const,
};

/**
 * Was this mutation one of the two above? Reads the key off the mutation's
 * own options, which is the only thing a MutationCache subscriber is given
 * to identify it by.
 */
export function isLockMutationKey(key: unknown): boolean {
  return Array.isArray(key) && key[0] === lockKeys.all[0];
}

/**
 * The discriminator on the 409 body (backend api/edit_lock.py:
 * EDIT_LOCK_HELD). Matched on instead of the message text because these
 * routers answer 409 for several unrelated refusals - a rota that is not a
 * draft, the staging singleton - and every one of those must keep being
 * handled as it was.
 */
export const EDIT_LOCK_HELD = "edit_lock_held";

/** The `detail` object of a lock 409. */
export interface EditLockConflict {
  message: string;
  code: typeof EDIT_LOCK_HELD;
  area: LockableArea;
  holder_user_id: number;
  holder_name: string;
  acquired_at: string | null;
  last_activity_at: string | null;
}

export type EditLockError = ApiError & { detail: EditLockConflict };

/**
 * "Was this refusal the editing lock?" - for a mutation's onError, and for
 * the acquire below, where a 409 is an expected outcome rather than a
 * failure.
 *
 * Structural rather than a cast: apiClient throws a plain object whose
 * `detail` is whatever the body contained, so nothing guarantees the shape
 * but the server.
 */
export function isEditLockError(error: unknown): error is EditLockError {
  if (typeof error !== "object" || error === null) {
    return false;
  }
  const candidate = error as { status?: unknown; detail?: unknown };
  if (candidate.status !== 409) {
    return false;
  }
  const detail = candidate.detail;
  return (
    typeof detail === "object" &&
    detail !== null &&
    (detail as { code?: unknown }).code === EDIT_LOCK_HELD
  );
}

/**
 * Every lock the caller may know about, refreshed on a timer.
 *
 * Filtered server-side by the caller's READ level, so a reception-only
 * login gets at most the reception row. Polled rather than pushed: a
 * holder who loses their lock (or a reader who gains it back) sees the
 * change within one interval, which is enough for a banner and costs no
 * WebSocket. GET /locks sweeps nothing, so polling it has no side effects.
 */
export function useLocks() {
  return useQuery({
    queryKey: lockKeys.list(),
    queryFn: () => apiClient.get<EditLock[]>("/locks"),
    refetchInterval: 25_000,
  });
}

/**
 * Take the lock on a section, or find out who has it.
 *
 * A 409 is an ordinary outcome here, not a fault: it means somebody else
 * is in the section, and the answer is to render read-only and say so. The
 * cache is invalidated either way, so the banner reflects the new truth
 * (mine now, or theirs still) without waiting for the next poll.
 */
export function useAcquireLock() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationKey: lockKeys.mutations(),
    mutationFn: (area: LockableArea) => apiClient.post<EditLock>(`/locks/${area}`),
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: lockKeys.all });
    },
  });
}

/**
 * Give the lock back. Always 204, including when the caller did not hold
 * it - see the router's docstring: this is fired on leaving a section,
 * where "release whatever I have here, if anything" is the only thing it
 * can usefully mean.
 */
export function useReleaseLock() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationKey: lockKeys.mutations(),
    mutationFn: (area: LockableArea) => apiClient.delete<void>(`/locks/${area}`),
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: lockKeys.all });
    },
  });
}

/**
 * Release on page hide: closing the tab, or navigating away from the app
 * entirely. Not a hook and not a mutation - React has already stopped
 * caring by the time this runs, so there is nothing to update.
 *
 * **Why a `keepalive` fetch and not `navigator.sendBeacon`.** A beacon
 * cannot set request headers, and this API authenticates with a bearer
 * token in `Authorization`; a beacon release would therefore 401 every
 * time, and the only ways to make it work are to put a session token in a
 * request body or to add a second, token-in-body release endpoint. Both
 * were rejected: `fetch(..., { keepalive: true })` is the modern
 * replacement for sendBeacon, survives the document being torn down in the
 * same way, and *can* carry the header - so the normal endpoint and the
 * normal auth are all that is needed.
 *
 * Best effort regardless, and deliberately not load-bearing: a crashed
 * tab, a closed laptop and a dead network all release nothing, and the
 * 15-minute idle timeout is the real answer to a holder who has gone away.
 * The same goes for the browser coming back to a cached page after this
 * has fired - the lock is gone, but the first write takes it again
 * (require_edit_lock: a write with no lock takes the lock), so the section
 * heals itself rather than stranding anyone.
 */
export function releaseLockOnPageHide(area: LockableArea): void {
  void apiClient.delete<void>(`/locks/${area}`, { keepalive: true }).catch(() => {
    // Nothing can be done and nobody is listening - see above.
  });
}
