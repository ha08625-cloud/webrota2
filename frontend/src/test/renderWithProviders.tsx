import type { ReactElement, ReactNode } from "react";

import { render } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes } from "react-router-dom";

import type { AccessLevel, AuthUser, Permissions } from "@/api/types";
import type { PermissionArea } from "@/auth/AuthContext";
import { AuthProvider, PermissionAreaProvider } from "@/auth/AuthContext";

import { makeAuthUser } from "./fixtures/reference";

interface RenderWithProvidersOptions {
  /** Initial history entry, e.g. "/rota/7". Defaults to "/". */
  route?: string;
  /** Path pattern the rendered element is mounted at. Defaults to "/". */
  path?: string;
  /**
   * Extra routes mounted alongside the one under test - lets a test
   * assert *where* a navigation landed (e.g. a probe component at
   * "/rota/:id" reading useParams()) rather than only that some
   * navigation happened.
   */
  additionalRoutes?: { path: string; element: ReactElement }[];
  /**
   * Access level of the logged-in user the tree sees. A LABEL only -
   * nothing gates on it. Pass `permissions` to change what the tree may do.
   */
  accessLevel?: AccessLevel;
  /**
   * What the logged-in user may do. Defaults to the Manager preset -
   * everything granted - so a test that says nothing sees the full set of
   * controls; pass a narrower set (PERMISSION_PRESETS in the fixtures) to
   * assert what a restricted login gets.
   */
  permissions?: Permissions;
  /**
   * The section the component under test is mounted in, which is what
   * useCanWrite() resolves against. Defaults to "clinical", matching most
   * pages; pass "reception" or a capability for a component that lives
   * elsewhere. In the running app each shell provides this.
   */
  area?: PermissionArea;
  /**
   * Any other field of the logged-in user the tree sees. Mostly for the
   * staff link (`linked_doctor` / `linked_reception_staff`), which the
   * self-service defaults read through useLinkedDoctorId(): a test for
   * "opens on my own row" supplies one here, and the fixture's unlinked
   * default keeps every other test seeing the pre-link behaviour.
   */
  authUser?: Partial<AuthUser>;
}

export function renderWithProviders(ui: ReactElement, options: RenderWithProvidersOptions = {}) {
  const {
    route = "/",
    path = "/",
    additionalRoutes = [],
    accessLevel = "manager",
    permissions,
    area = "clinical",
    authUser = {},
  } = options;

  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });

  return {
    queryClient,
    ...render(
      <QueryClientProvider client={queryClient}>
        <AuthProvider
          user={makeAuthUser({
            access_level: accessLevel,
            ...(permissions ? { permissions } : {}),
            ...authUser,
          })}
        >
          <PermissionAreaProvider area={area}>
            <MemoryRouter initialEntries={[route]}>
              <Routes>
                <Route path={path} element={ui} />
                {additionalRoutes.map((r) => (
                  <Route key={r.path} path={r.path} element={r.element} />
                ))}
              </Routes>
            </MemoryRouter>
          </PermissionAreaProvider>
        </AuthProvider>
      </QueryClientProvider>,
    ),
  };
}

interface AuthWrapperOptions {
  /** What the tree may do. Defaults to the fixture's everything-granted set. */
  permissions?: Permissions;
  /** The section the tree is mounted in. Defaults to "clinical". */
  area?: PermissionArea;
  /** Any other field of the logged-in user, e.g. a staff link. */
  authUser?: Partial<AuthUser>;
}

/**
 * Wrapper for tests that render a component with plain RTL `render()` - no
 * query client and no router, but still needing an auth context because the
 * component consults it. Pass as `render(ui, { wrapper: authWrapper() })`.
 *
 * `accessLevel` is a label, like the option of the same name above; nothing
 * gates on it. Pass `{ permissions }` to change what the tree may do.
 */
export function authWrapper(
  accessLevel: AccessLevel = "manager",
  { permissions, area = "clinical", authUser = {} }: AuthWrapperOptions = {},
) {
  return function AuthWrapper({ children }: { children: ReactNode }) {
    return (
      <AuthProvider
        user={makeAuthUser({
          access_level: accessLevel,
          ...(permissions ? { permissions } : {}),
          ...authUser,
        })}
      >
        <PermissionAreaProvider area={area}>{children}</PermissionAreaProvider>
      </AuthProvider>
    );
  };
}
