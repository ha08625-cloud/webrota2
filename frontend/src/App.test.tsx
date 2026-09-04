import { HttpResponse, http } from "msw";
import { render, screen, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";

import type { AccessLevel } from "@/api/types";
import { AuthProvider } from "@/auth/AuthContext";
import { makeAuthUser } from "@/test/fixtures/reference";
import { server } from "@/test/msw/server";

import { App } from "./App";

/**
 * App owns its own BrowserRouter, so the route under test is set on
 * window.history rather than through renderWithProviders' MemoryRouter.
 * These tests cover the clinical nav's structure only - the pages
 * themselves have their own suites, and their data fetches are stubbed
 * empty here.
 *
 * The auth provider is supplied here rather than by LoginGate, which
 * wraps App in main.tsx but is not part of these tests. Manager by
 * default; pass a level to check what a lower tier is offered.
 */
function renderAt(path: string, accessLevel: AccessLevel = "manager") {
  server.use(
    http.get("/api/v1/doctors", () => HttpResponse.json([])),
    http.get("/api/v1/leave", () => HttpResponse.json([])),
    http.get("/api/v1/closures", () => HttpResponse.json([])),
    http.get("/api/v1/signatures", () => HttpResponse.json([])),
  );
  window.history.pushState({}, "", path);

  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <AuthProvider user={makeAuthUser({ access_level: accessLevel })}>
        <App />
      </AuthProvider>
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

  it("renders the sub-tab bar above the active tabbed page", async () => {
    renderAt("/clinical/school-holidays");

    expect(screen.getByRole("tab", { name: "School Holidays" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    expect(await screen.findByText("No schools.")).toBeInTheDocument();
  });

  it("does not render the sub-tab bar on an ungrouped page", () => {
    renderAt("/clinical/counters");

    expect(screen.queryByRole("tablist", { name: "Session management" })).not.toBeInTheDocument();
  });
});

describe("ClinicalShell nav by access level", () => {
  it("offers Users to a manager", () => {
    renderAt("/clinical/counters");

    const nav = screen.getByRole("navigation");
    expect(within(nav).getByRole("link", { name: "Users" })).toBeInTheDocument();
  });

  it.each(["admin", "doctor", "nurse"] as const)("hides Users from %s", (level) => {
    renderAt("/clinical/counters", level);

    const nav = screen.getByRole("navigation");
    expect(within(nav).queryByRole("link", { name: "Users" })).not.toBeInTheDocument();
  });

  it("offers Audit Log to a manager", () => {
    renderAt("/clinical/counters");

    const nav = screen.getByRole("navigation");
    expect(within(nav).getByRole("link", { name: "Audit Log" })).toBeInTheDocument();
  });

  it.each(["admin", "doctor", "nurse"] as const)("hides Audit Log from %s", (level) => {
    renderAt("/clinical/counters", level);

    const nav = screen.getByRole("navigation");
    expect(within(nav).queryByRole("link", { name: "Audit Log" })).not.toBeInTheDocument();
  });

  it("renders the audit log route for a manager", async () => {
    server.use(
      http.get("/api/v1/users", () => HttpResponse.json([])),
      http.get("/api/v1/audit", () => HttpResponse.json({ items: [], total: 0 })),
    );
    renderAt("/clinical/audit");

    expect(await screen.findByText(/No audit entries match/)).toBeInTheDocument();
  });

  it("lands a deep link to the audit log on the no-access state below manager", async () => {
    renderAt("/clinical/audit", "nurse");

    expect(await screen.findByText(/do not have access to the audit log/i)).toBeInTheDocument();
  });

  it("keeps every other entry, so a read-only user still sees the whole app", () => {
    renderAt("/clinical/counters", "nurse");

    const nav = screen.getByRole("navigation");
    for (const label of [
      "Generate new rotas",
      "Staging",
      "Master Rota",
      "Staff",
      "Counters",
      "Calendar Feed",
    ]) {
      expect(within(nav).getByRole("link", { name: label })).toBeInTheDocument();
    }
  });

  it("renders the calendar feed route", async () => {
    renderAt("/clinical/calendar", "nurse");

    expect(await screen.findByRole("heading", { name: "Calendar Feed" })).toBeInTheDocument();
  });

  it("offers Change password at every level, since /users is manager-only", () => {
    renderAt("/clinical/counters", "nurse");

    expect(screen.getByRole("button", { name: "Change password" })).toBeInTheDocument();
  });
});

/**
 * The documents section is a sub-tab shell rather than a single page, so
 * these cover the route conversion: the pre-existing /signatures bookmark
 * still lands on the signatures page, and the second tab has a route.
 */
describe("documents section", () => {
  it("renders the signatures page at /signatures", async () => {
    renderAt("/signatures");

    expect(await screen.findByRole("heading", { name: "Signatures" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Study EOI" })).toBeInTheDocument();
  });

  it("renders the EOI page at /signatures/eoi", async () => {
    renderAt("/signatures/eoi");

    expect(await screen.findByRole("heading", { name: "Study EOI" })).toBeInTheDocument();
  });
});
