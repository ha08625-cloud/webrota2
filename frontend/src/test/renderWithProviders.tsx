import type { ReactElement } from "react";

import { render } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes } from "react-router-dom";

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
}

export function renderWithProviders(ui: ReactElement, options: RenderWithProvidersOptions = {}) {
  const { route = "/", path = "/", additionalRoutes = [] } = options;

  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });

  return {
    queryClient,
    ...render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={[route]}>
          <Routes>
            <Route path={path} element={ui} />
            {additionalRoutes.map((r) => (
              <Route key={r.path} path={r.path} element={r.element} />
            ))}
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    ),
  };
}