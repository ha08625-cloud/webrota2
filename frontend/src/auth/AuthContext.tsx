import { createContext, useContext, useMemo, type ReactNode } from "react";

import type { AuthUser, Permissions } from "@/api/types";

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
 * May the user write in this section? The area comes from the enclosing
 * PermissionAreaProvider, so a page or grid asks the same question whichever
 * section it is mounted in. Pass an area explicitly only to ask about a
 * *different* section than the one you are rendered in.
 */
export function useCanWrite(area?: PermissionArea): boolean {
  const permissions = usePermissions();
  const contextArea = usePermissionArea();
  const resolved = area ?? contextArea;
  return resolved !== null && canWriteArea(permissions, resolved);
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
  const canWrite = useCanWrite();
  return canWrite ? {} : { disabled: true, title: NO_WRITE_ACCESS_TITLE };
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
