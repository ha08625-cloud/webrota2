import { createContext, useContext, useMemo, type ReactNode } from "react";

import type { AccessLevel, AuthUser } from "@/api/types";

/**
 * The logged-in user, plus the two booleans everything else in the UI
 * actually asks about (role-based auth, Task 3).
 *
 * The tier comparisons live here and nowhere else: components ask
 * `useCanWrite()` / `useIsManager()` rather than comparing
 * `user.access_level === "manager"` themselves, so adding or renaming a
 * level is a one-file change.
 *
 * This gating is UX only (role-based auth, Design Decision 8). The 403
 * from the API is the security boundary; hiding and disabling controls
 * here just stops a viewer being offered buttons that can only fail.
 */
export interface AuthState {
  user: AuthUser | null;
  /** admin or manager - may write anything outside user management. */
  canWrite: boolean;
  /** manager - may additionally manage users. */
  isManager: boolean;
}

/** Tooltip for a control disabled because the current user cannot write. */
export const NO_WRITE_ACCESS_TITLE =
  "Your access level does not allow changes. Ask a manager or admin.";

const WRITE_LEVELS: readonly AccessLevel[] = ["manager", "admin"];

/**
 * Deny by default. A component rendered outside an AuthProvider gets no
 * write controls rather than all of them, so forgetting the provider is a
 * visible bug rather than a silent hole. In the running app LoginGate
 * always provides it; in tests renderWithProviders provides a manager
 * unless the test asks for another tier.
 */
const AuthContext = createContext<AuthState>({
  user: null,
  canWrite: false,
  isManager: false,
});

interface AuthProviderProps {
  user: AuthUser | null;
  children: ReactNode;
}

export function AuthProvider({ user, children }: AuthProviderProps) {
  const value = useMemo<AuthState>(
    () => ({
      user,
      canWrite: user !== null && WRITE_LEVELS.includes(user.access_level),
      isManager: user !== null && user.access_level === "manager",
    }),
    [user],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  return useContext(AuthContext);
}

export function useCanWrite(): boolean {
  return useAuth().canWrite;
}

/**
 * Props to spread onto a control that writes: nothing at all for a
 * manager or admin, `disabled` plus an explaining tooltip for everyone
 * else. Disabled rather than hidden, deliberately (Task 3 instruction 5) -
 * a viewer can still see that the capability exists and who to ask.
 *
 * Spread it *after* any `disabled` the control sets for its own reasons
 * (`disabled={mutation.isPending} {...writeGate}`) so the gate wins;
 * when the user can write it is an empty object and changes nothing.
 */
export function useWriteGate(): { disabled?: true; title?: string } {
  const canWrite = useCanWrite();
  return canWrite ? {} : { disabled: true, title: NO_WRITE_ACCESS_TITLE };
}

export function useIsManager(): boolean {
  return useAuth().isManager;
}
