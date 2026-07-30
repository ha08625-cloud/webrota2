import { HttpResponse, http } from "msw";
import { render, screen, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";

import { server } from "@/test/msw/server";

import { App } from "./App";

/**
 * App owns its own BrowserRouter, so the route under test is set on
 * window.history rather than through renderWithProviders' MemoryRouter.
 * These tests cover the clinical nav's structure only - the pages
 * themselves have their own suites, and their data fetches are stubbed
 * empty here.
 */
function renderAt(path: string) {
  server.use(
    http.get("/api/v1/doctors", () => HttpResponse.json([])),
    http.get("/api/v1/leave", () => HttpResponse.json([])),
    http.get("/api/v1/closures", () => HttpResponse.json([])),
  );
  window.history.pushState({}, "", path);

  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <App />
    </QueryClientProvider>,
  );
}

describe("ClinicalShell nav", () => {
  it("groups the session-planning pages behind one Session Management entry", () => {
    renderAt("/clinical/closures");

    const nav = screen.getByRole("navigation");
    expect(within(nav).getByRole("link", { name: "Session Management" })).toBeInTheDocument();
    // The five sub-tabs are no longer top-level nav entries. "Closures" and
    // "Extra Sessions" still appear on the page - in the sub-tab bar - so the
    // assertion is scoped to the nav element.
    for (const label of ["Assign Leave", "Leave Planning", "Extra Sessions", "Closures"]) {
      expect(within(nav).queryByRole("link", { name: label })).not.toBeInTheDocument();
    }
  });

  it("keeps Session Management active on any of its sub-tabs", () => {
    renderAt("/clinical/closures");

    const nav = screen.getByRole("navigation");
    expect(within(nav).getByRole("link", { name: "Session Management" }).className).toContain(
      "text-accent",
    );
  });

  it("renders the sub-tab bar above the active tabbed page", () => {
    renderAt("/clinical/school-holidays");

    expect(screen.getByRole("tab", { name: "School Holidays" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    expect(screen.getByText(/Coming soon/)).toBeInTheDocument();
  });

  it("does not render the sub-tab bar on an ungrouped page", () => {
    renderAt("/clinical/counters");

    expect(screen.queryByRole("tablist", { name: "Session management" })).not.toBeInTheDocument();
  });
});
