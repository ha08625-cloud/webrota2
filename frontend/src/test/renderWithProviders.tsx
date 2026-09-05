import type { ReactElement, ReactNode } from "react";

import { render } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes } from "react-router-dom";

import type { AccessLevel, AuthUser } from "@/api/types";
import { AuthProvider } from "@/auth/AuthContext";

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
   * Access level of the logged-in user the tree sees (role-based auth,
   * Task 3). Defaults to "manager" so every pre-existing test keeps
   * seeing the full set of controls; pass "doctor" or "nurse" to assert
   * what a read-only user gets, or "admin" for writes-but-not-users.
   */
  accessLevel?: AccessLevel;
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
    authUser = {},
  } = options;

  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });

  return {
    queryClient,
    ...render(
      <QueryClientProvider client={queryClient}>
        <AuthProvider user={makeAuthUser({ access_level: accessLevel, ...authUser })}>
          <MemoryRouter initialEntries={[route]}>
            <Routes>
              <Route path={path} element={ui} />
              {additionalRoutes.map((r) => (
                <Route key={r.path} path={r.path} element={r.element} />
              ))}
            </Routes>
          </MemoryRouter>
        </AuthProvider>
      </QueryClientProvider>,
    ),
  };
}

/**
 * Wrapper for tests that render a component with plain RTL `render()` -
 * no query client and no router, but still needing an access level
 * because the component consults the auth context. Pass as
 * `render(ui, { wrapper: authWrapper("nurse") })`.
 */
export function authWrapper(accessLevel: AccessLevel = "manager", authUser: Partial<AuthUser> = {}) {
  return function AuthWrapper({ children }: { children: ReactNode }) {
    return (
      <AuthProvider user={makeAuthUser({ access_level: accessLevel, ...authUser })}>
        {children}
      </AuthProvider>
    );
  };
}
