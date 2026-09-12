import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";

import { useQueryClient } from "@tanstack/react-query";

import {
  isEditLockError,
  isLockMutationKey,
  lockKeys,
  releaseLockOnPageHide,
  useAcquireLock,
  useLocks,
  useReleaseLock,
  type EditLockConflict,
  type LockableArea,
} from "@/api/locks";
import type { AuthUser, Permissions } from "@/api/types";
import { getToken } from "@/auth/tokenStore";

/**
 * The logged-in user, plus the two things everything else in the UI
 * actually asks about: what this login may do, and who it is on the rota.
 *
 * Authorization reads the permission set and nothing else. `access_level`
 * survives as a label on the Users page (see api/types.ts) and is never
 * consulted here. Components ask `useCanWrite()` / `useCanRead()` /
 * `useCanAdminUsers()` rather than reaching into `user.permissions`
 * themselves, so the shape of the set lives in one file. The links are
 * unwrapped here for the same reason: components ask `useLinkedDoctorId()`
 * rather than reaching into `user.linked_doctor?.id`.
 *
 * The two are independent of each other. The permission set is what you
 * may do; the link is who you are on the rota. Neither derives the other -
 * a user administrator may be a doctor, a read-only login may have no
 * clinical row.
 *
 * This gating is UX only. The 403 from the API is the security boundary;
 * hiding and disabling controls here just stops a viewer being offered
 * buttons that can only fail.
 */
export interface AuthState {
  user: AuthUser | null;
  /** What this login may do. Deny-everything when there is no user. */
  permissions: Permissions;
  /** The Doctor this login belongs to, or null when unlinked. */
  linkedDoctorId: number | null;
  /** The ReceptionStaff member this login belongs to, or null when unlinked. */
  linkedReceptionStaffId: number | null;
}

/** One of the five permissions (models/permissions.py, schemas/auth.py). */
export type PermissionArea = keyof Permissions;

/** Tooltip for a control disabled because the current user cannot write. */
export const NO_WRITE_ACCESS_TITLE =
  "Your permissions do not allow changes here. Ask a user administrator.";

/**
 * Tooltip for a control disabled because somebody else is in this section.
 * A separate sentence from NO_WRITE_ACCESS_TITLE because the two are
 * different problems with different answers: "ask a user administrator"
 * sends a writer who is merely second into the section to entirely the
 * wrong person, when what they need is to go and ask the named colleague
 * to leave it.
 */
export function editLockTitle(holderName: string | null): string {
  const who = holderName ?? "Someone else";
  return `${who} is editing this section. You can read it, but not change it, until they leave.`;
}

/**
 * Grants nothing at all - the same shape as the backend's
 * DEFAULT_PERMISSIONS, and for the same reason: an accidental viewer is
 * recoverable, an accidental administrator is a silent security hole.
 */
export const DENIED_PERMISSIONS: Permissions = {
  clinical: "none",
  reception: "none",
  signatures: false,
  study_eoi: false,
  user_admin: false,
};

/**
 * Deny by default. A component rendered outside an AuthProvider gets no
 * access rather than all of it, so forgetting the provider is a visible bug
 * rather than a silent hole. In the running app LoginGate always provides
 * it; in tests renderWithProviders provides the Manager preset unless the
 * test asks for another set.
 */
const AuthContext = createContext<AuthState>({
  user: null,
  permissions: DENIED_PERMISSIONS,
  linkedDoctorId: null,
  linkedReceptionStaffId: null,
});

/**
 * The section a subtree belongs to, so `useCanWrite()` needs no argument and
 * the write-gated call sites that predate per-area permissions are unchanged.
 * Each shell provides it; the documents shell provides it per route, since
 * its two pages are two different permissions.
 *
 * null rather than a default area: a component that asks about writes from
 * outside any section gets a "no" it can act on, instead of silently being
 * judged against whichever area happened to be listed first.
 */
const PermissionAreaContext = createContext<PermissionArea | null>(null);

export function PermissionAreaProvider({
  area,
  children,
}: {
  area: PermissionArea;
  children: ReactNode;
}) {
  return <PermissionAreaContext.Provider value={area}>{children}</PermissionAreaContext.Provider>;
}

/**
 * The read and write tests as plain functions, for callers that already hold
 * a permission set: the nav predicates, the route guards and the landing
 * tiles all decide about a section other than the one they are rendered in,
 * which is exactly what the hooks below deliberately cannot do.
 *
 * A boolean permission grants reads and writes together - there is no
 * meaningful read-only view of a document generator or of user
 * administration - so both functions return the flag for those three.
 */
export function canReadArea(permissions: Permissions, area: PermissionArea): boolean {
  const granted = permissions[area];
  return typeof granted === "boolean" ? granted : granted !== "none";
}

export function canWriteArea(permissions: Permissions, area: PermissionArea): boolean {
  const granted = permissions[area];
  return typeof granted === "boolean" ? granted : granted === "write";
}

interface AuthProviderProps {
  user: AuthUser | null;
  children: ReactNode;
}

export function AuthProvider({ user, children }: AuthProviderProps) {
  const value = useMemo<AuthState>(
    () => ({
      user,
      // `??` guards the wire, not just the null user: a response that omits
      // the field must deny rather than crash on the first property read.
      permissions: user?.permissions ?? DENIED_PERMISSIONS,
      linkedDoctorId: user?.linked_doctor?.id ?? null,
      linkedReceptionStaffId: user?.linked_reception_staff?.id ?? null,
    }),
    [user],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  return useContext(AuthContext);
}

export function usePermissions(): Permissions {
  return useAuth().permissions;
}

/** The section the calling subtree is in, or null outside every shell. */
export function usePermissionArea(): PermissionArea | null {
  return useContext(PermissionAreaContext);
}

/**
 * Whether somebody else is currently editing this section, for the
 * subtree inside one lockable shell.
 *
 * This is not a second kind of permission, and there is deliberately no
 * `useIsLocked()` for components to consult: the lock is one more input to
 * the single question "may I write here, right now", which `useCanWrite()`
 * below already answers for roughly twenty call sites. Lowering that hook
 * turns the whole section read-only with no per-component work, and the
 * grids get their stronger read-only treatment (no drag sources, no
 * popover) from the same change.
 */
export interface EditLockNotice {
  /**
   * Which moment produced this notice. "entry" is the acquire being
   * refused on the way into the section - the one-time dialog that
   * explains why the whole screen is read-only. "write" is a write refused
   * mid-session, which is how a holder who went idle for fifteen minutes
   * and lost the lock finds out: their screen still believed it could
   * write until the server said otherwise.
   */
  kind: "entry" | "write";
  /** The server's sentence, e.g. "Kristel is editing the clinical rota". */
  message: string;
  holderName: string;
  /** When the holder started, or null if the server could not say. */
  acquiredAt: string | null;
}

export interface EditLockState {
  /** The section this lock state describes, or null outside a provider. */
  area: LockableArea | null;
  /**
   * True only when the server would actually refuse this user's writes:
   * somebody else holds the lock AND it is not idle. An idle lock is
   * takeable - require_edit_lock hands the section to whoever writes next
   * - so treating it as held would lock the UI tighter than the API, and
   * leave a writer staring at a read-only screen nothing will ever
   * release.
   */
  heldByOther: boolean;
  /** Who holds it, whoever that is. Null when nobody does. */
  holderName: string | null;
  /** When the current holder took it, for the banner. Null when nobody holds it. */
  holderSince: string | null;
  holderIsMe: boolean;
  /**
   * The pending "you cannot edit here right now" notice, or null. A single
   * slot rather than a queue, like components/Toast.tsx: the second copy of
   * the same news is not worth a second dialog.
   */
  notice: EditLockNotice | null;
  /** Dismiss the notice above. There is no takeover button - see the plan. */
  dismissNotice: () => void;
  /**
   * Give the lock back now rather than on unmount - the logout path, which
   * clears the token before the tree unmounts and so cannot release it
   * afterwards. Resolves either way; releasing is always best effort.
   */
  release: () => Promise<void>;
}

/**
 * Nobody holds anything. Note this is NOT the deny-by-default that
 * AuthContext and PermissionAreaContext use, and the difference is
 * deliberate: the server is the boundary for the lock (require_edit_lock
 * refuses every write from a non-holder), so a missing provider costing a
 * user their write access would be a bug that looks exactly like an
 * outage, with no button anywhere to press. Forgetting the provider must
 * degrade to "no banner", not to "the app is read-only".
 */
const EditLockContext = createContext<EditLockState>({
  area: null,
  heldByOther: false,
  holderName: null,
  holderSince: null,
  holderIsMe: false,
  notice: null,
  dismissNotice: () => {},
  release: async () => {},
});

/** The notice a 409's detail describes. */
function noticeFrom(kind: EditLockNotice["kind"], detail: EditLockConflict): EditLockNotice {
  return {
    kind,
    message: detail.message,
    holderName: detail.holder_name,
    acquiredAt: detail.acquired_at,
  };
}

/**
 * Holds the lock on `area` for as long as the section is mounted.
 *
 * Acquisition is automatic and has no button: entering the section is the
 * request. Only a login that could write here asks - a read-only login
 * never acquires and so never blocks anybody. A 409 from the acquire is an
 * expected outcome rather than an error; it means somebody else is in
 * there, and the poll below is what the UI reads either way.
 *
 * Nothing here keeps a lock alive. The idle timer is stamped by writes
 * that pass the server-side gate and by nothing else, so an open tab does
 * not hold a section hostage - which is what makes the absence of a force
 * takeover safe.
 *
 * It is also the one place that reacts to a lock 409 from ANY mutation in
 * the app, so no grid, page or dialog has to know the lock exists. See the
 * MutationCache subscription below.
 */
export function EditLockProvider({
  area,
  children,
}: {
  area: LockableArea;
  children: ReactNode;
}) {
  const { user, permissions } = useAuth();
  const mayWrite = canWriteArea(permissions, area);
  const queryClient = useQueryClient();

  const [notice, setNotice] = useState<EditLockNotice | null>(null);
  const dismissNotice = useCallback(() => setNotice(null), []);

  const locksQuery = useLocks();
  const acquireMutation = useAcquireLock();
  const releaseMutation = useReleaseLock();
  const acquire = acquireMutation.mutate;
  const release = releaseMutation.mutateAsync;

  const releaseHere = useCallback(async () => {
    // No token means we have already been logged out: the session is gone
    // server-side, the DELETE would 401, and a 401 fires the global
    // unauthorized listener - which would stamp over the reason the
    // password-change flow just put on the login form. The lock falls to
    // the idle timeout instead, which is what it is for.
    if (!mayWrite || getToken() === null) {
      return;
    }
    try {
      await release(area);
    } catch {
      // Best effort, always: releasing is a courtesy to the next person,
      // never something the user should be told failed.
    }
  }, [area, mayWrite, release]);

  useEffect(() => {
    if (!mayWrite) {
      return;
    }
    acquire(area);
    return () => {
      void releaseHere();
    };
  }, [area, mayWrite, acquire, releaseHere]);

  // Closing the tab, or leaving the app for another site. The provider
  // unmount above never runs for either, so without this the section stays
  // locked until the idle timeout - fifteen minutes of a colleague being
  // told to go and ask somebody who has gone home. Best effort: see
  // releaseLockOnPageHide for why this is a keepalive fetch and not a
  // beacon, and why a crashed tab is still the idle timeout's problem.
  //
  // `pagehide` rather than `beforeunload`, which mobile Safari never fires
  // and which blocks the back/forward cache.
  useEffect(() => {
    if (!mayWrite) {
      return;
    }
    function handlePageHide() {
      if (getToken() === null) {
        return;
      }
      releaseLockOnPageHide(area);
    }
    window.addEventListener("pagehide", handlePageHide);
    return () => window.removeEventListener("pagehide", handlePageHide);
  }, [area, mayWrite]);

  // The acquire being refused: somebody else is in the section, and the
  // user is about to find their whole screen read-only with no explanation.
  // Once per mount, which is once per section entry - the shell stays
  // mounted while they navigate within the section, so clicking through
  // five pages does not produce five dialogs.
  //
  // The ref, not just the null check, is what makes "once" true: dismissing
  // clears the notice, and without the guard any later re-render carrying
  // the same mutation error would put it straight back.
  const acquireError = acquireMutation.error;
  const entryNoticeRaised = useRef(false);
  useEffect(() => {
    if (entryNoticeRaised.current || !isEditLockError(acquireError)) {
      return;
    }
    entryNoticeRaised.current = true;
    setNotice(noticeFrom("entry", acquireError.detail));
  }, [acquireError]);

  // Every OTHER mutation in the app, in one place. A holder who went idle
  // for fifteen minutes has lost the lock while their screen still
  // believed it could write; the first save is what finds out, and the
  // alternative to this subscription is an onError in every mutation in
  // the codebase.
  //
  // Invalidating the locks query is the important half: it flips the
  // section read-only within a second rather than up to a poll interval
  // later, so the user is not left clicking controls that cannot work.
  //
  // What this does NOT do is silence a page's own error handling: a grid
  // that shows "Could not apply that change" on any failure still shows
  // it, underneath this dialog. Suppressing that would mean editing every
  // one of those call sites, which is the per-mutation work this
  // subscription exists to avoid - and the dialog is the message that
  // explains, so the toast beneath it is redundant rather than wrong.
  useEffect(() => {
    return queryClient.getMutationCache().subscribe((event) => {
      if (event.type !== "updated" || event.action.type !== "error") {
        return;
      }
      const error = event.action.error;
      if (!isEditLockError(error) || error.detail.area !== area) {
        return;
      }
      // The lock's own acquire has the dialog above; a release never
      // 409s. Letting them through here would double up on entry.
      if (isLockMutationKey(event.mutation.options.mutationKey)) {
        return;
      }
      void queryClient.invalidateQueries({ queryKey: lockKeys.all });
      setNotice(noticeFrom("write", error.detail));
    });
  }, [area, queryClient]);

  const value = useMemo<EditLockState>(() => {
    const lock = locksQuery.data?.find((row) => row.area === area) ?? null;
    const holderIsMe = lock !== null && user !== null && lock.user_id === user.id;
    return {
      area,
      heldByOther: lock !== null && !holderIsMe && !lock.idle,
      holderName: lock?.user_name ?? null,
      holderSince: lock?.acquired_at ?? null,
      holderIsMe,
      notice,
      dismissNotice,
      release: releaseHere,
    };
  }, [area, locksQuery.data, user, notice, dismissNotice, releaseHere]);

  return <EditLockContext.Provider value={value}>{children}</EditLockContext.Provider>;
}

/** The lock state for the section the calling subtree is in. */
export function useEditLock(): EditLockState {
  return useContext(EditLockContext);
}

/**
 * May the user write in this section? The area comes from the enclosing
 * PermissionAreaProvider, so a page or grid asks the same question whichever
 * section it is mounted in. Pass an area explicitly only to ask about a
 * *different* section than the one you are rendered in.
 *
 * Two inputs, one answer: the permission set says whether this login may
 * ever write here, the section editing lock says whether it may right now.
 * Reads are never gated by the lock - see useCanRead, which is unchanged.
 */
export function useCanWrite(area?: PermissionArea): boolean {
  const permissions = usePermissions();
  const contextArea = usePermissionArea();
  const lock = useEditLock();
  const resolved = area ?? contextArea;
  if (resolved === null || !canWriteArea(permissions, resolved)) {
    return false;
  }
  // `lock.area === resolved` matters: an explicit argument asks about a
  // DIFFERENT section than the one this component is mounted in, and must
  // not be answered with this section's lock.
  return !(lock.area === resolved && lock.heldByOther);
}

/** May the user see this section at all? Resolves the area like useCanWrite. */
export function useCanRead(area?: PermissionArea): boolean {
  const permissions = usePermissions();
  const contextArea = usePermissionArea();
  const resolved = area ?? contextArea;
  return resolved !== null && canReadArea(permissions, resolved);
}

/**
 * Props to spread onto a control that writes: nothing at all when the user
 * may write in this section, `disabled` plus an explaining tooltip
 * otherwise. Disabled rather than hidden, deliberately - a viewer can still
 * see that the capability exists and who to ask.
 *
 * Spread it *after* any `disabled` the control sets for its own reasons
 * (`disabled={mutation.isPending} {...writeGate}`) so the gate wins;
 * when the user can write it is an empty object and changes nothing.
 */
export function useWriteGate(): { disabled?: true; title?: string } {
  const permissions = usePermissions();
  const contextArea = usePermissionArea();
  const lock = useEditLock();
  const canWrite = useCanWrite();

  if (canWrite) {
    return {};
  }
  // Which of the two refusals this is decides the sentence. A writer who is
  // merely second into the section must not be told to ask a user
  // administrator - that sends them to the wrong person for a problem that
  // resolves itself when their colleague leaves the section.
  const lockedOut =
    contextArea !== null &&
    lock.area === contextArea &&
    lock.heldByOther &&
    canWriteArea(permissions, contextArea);
  return {
    disabled: true,
    title: lockedOut ? editLockTitle(lock.holderName) : NO_WRITE_ACCESS_TITLE,
  };
}

/**
 * The `user_admin` permission: user management, the audit log, and the two
 * destructive endpoints the backend guards with it on top of their own
 * section (deleting reception staff, reissuing a calendar-feed link).
 */
export function useCanAdminUsers(): boolean {
  return usePermissions().user_admin;
}

/**
 * The linked staff ids, for the features that mean "mine" - defaulting a
 * picker to you, highlighting your row. Null means unlinked (or no
 * provider), which every caller must handle by falling back to the
 * unpersonalised behaviour rather than to some other person's data.
 */
export function useLinkedDoctorId(): number | null {
  return useAuth().linkedDoctorId;
}

export function useLinkedReceptionStaffId(): number | null {
  return useAuth().linkedReceptionStaffId;
}
