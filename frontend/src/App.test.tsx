import { HttpResponse, http } from "msw";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it } from "vitest";

import type { Permissions } from "@/api/types";
import { AuthProvider, editLockTitle } from "@/auth/AuthContext";
import { clearToken, setToken } from "@/auth/tokenStore";
import { PERMISSION_PRESETS, makeAuthUser } from "@/test/fixtures/reference";
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
 * wraps App in main.tsx but is not part of these tests. Everything granted
 * by default; pass a permission set to check what a narrower login is
 * offered.
 */
function renderAt(
  path: string,
  permissions: Permissions = PERMISSION_PRESETS.manager,
  locks: unknown[] = [],
) {
  server.use(
    http.get("/api/v1/doctors", () => HttpResponse.json([])),
    http.get("/api/v1/leave", () => HttpResponse.json([])),
    http.get("/api/v1/closures", () => HttpResponse.json([])),
    http.get("/api/v1/signatures", () => HttpResponse.json([])),
    // Nobody holds a section unless a test says so. `user_id` in a lock
    // passed here must not be the fixture user's, or it reads as "mine".
    http.get("/api/v1/locks", () => HttpResponse.json(locks)),
  );
  window.history.pushState({}, "", path);

  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <AuthProvider user={makeAuthUser({ permissions })}>
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

describe("ClinicalShell nav by permission", () => {
  it("keeps every entry bar the reader's committed-rota view for a writer", () => {
    renderAt("/clinical/counters", PERMISSION_PRESETS.rotaAdmin);

    const nav = screen.getByRole("navigation");
    for (const label of [
      "Generate new rotas",
      "Master Rota",
      "Clinic Types",
      "Staff",
      "Session Management",
      "Assign Duty",
      "Meetings",
      "Counters",
      "Calendar Feed",
    ]) {
      expect(within(nav).getByRole("link", { name: label })).toBeInTheDocument();
    }
    // Committed Rotas is the reader's view of the published rota; a writer
    // reaches the same rotas through the generate console's commit history.
    expect(within(nav).queryByRole("link", { name: "Committed Rotas" })).not.toBeInTheDocument();
  });

  // A reader's clinical nav is the three entries that mean something without
  // edit rights; the reference-data pages - and the generation console the
  // section index is - are hidden rather than shown with every control
  // disabled.
  it("offers a reader only the committed rotas, session management and calendar entries", () => {
    renderAt("/clinical/calendar", PERMISSION_PRESETS.readOnly);

    const nav = screen.getByRole("navigation");
    for (const label of ["Committed Rotas", "Session Management", "Calendar Feed"]) {
      expect(within(nav).getByRole("link", { name: label })).toBeInTheDocument();
    }
    for (const label of [
      "Generate new rotas",
      "Master Rota",
      "Clinic Types",
      "Staff",
      "Assign Duty",
      "Meetings",
      "Counters",
    ]) {
      expect(within(nav).queryByRole("link", { name: label })).not.toBeInTheDocument();
    }
  });

  it.each([
    "/clinical",
    "/clinical/master-rota",
    "/clinical/clinic-types",
    "/clinical/doctors",
    "/clinical/duty",
    "/clinical/recurring-notes",
    "/clinical/counters",
  ])("sends a reader who bookmarked %s to the committed rotas page", async (path) => {
    renderAt(path, PERMISSION_PRESETS.readOnly);

    // Still inside the clinical section - the nav is there - but on the
    // Committed Rotas page rather than the write-only one. The section
    // index is in this list too: for a reader it is a write-only page like
    // any other, and must not bounce back to itself.
    const nav = screen.getByRole("navigation");
    expect(within(nav).getByRole("link", { name: "Committed Rotas" }).className).toContain(
      "text-accent",
    );
    expect(await screen.findByRole("heading", { name: "Committed rotas" })).toBeInTheDocument();
  });

  it("still lands a writer on the generate console at the section index", async () => {
    renderAt("/clinical", PERMISSION_PRESETS.rotaAdmin);

    expect(await screen.findByRole("heading", { name: "Rota" })).toBeInTheDocument();
  });

  it("sends a writer who followed a committed rotas link to the generate console", async () => {
    renderAt("/clinical/committed", PERMISSION_PRESETS.rotaAdmin);

    expect(await screen.findByRole("heading", { name: "Rota" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Committed rotas" })).not.toBeInTheDocument();
  });

  it("keeps the Session Management sub-tabs available to a reader", () => {
    renderAt("/clinical/closures", PERMISSION_PRESETS.readOnly);

    for (const label of [
      "Annual Planner",
      "Individual Leave",
      "Extra Sessions",
      "Closures",
      "School Holidays",
    ]) {
      expect(screen.getByRole("tab", { name: label })).toBeInTheDocument();
    }
  });

  // Both moved to /admin, so neither is a clinical nav entry any more,
  // whatever the login holds.
  it.each(["Users", "Audit Log"])("no longer offers %s in the clinical nav", (label) => {
    renderAt("/clinical/counters");

    const nav = screen.getByRole("navigation");
    expect(within(nav).queryByRole("link", { name: label })).not.toBeInTheDocument();
  });

  it("renders the calendar feed route", async () => {
    renderAt("/clinical/calendar", PERMISSION_PRESETS.readOnly);

    expect(await screen.findByRole("heading", { name: "Calendar Feed" })).toBeInTheDocument();
  });

  it("offers Change password at every permission set, since user management is separate", () => {
    renderAt("/clinical/counters", PERMISSION_PRESETS.readOnly);

    expect(screen.getByRole("button", { name: "Change password" })).toBeInTheDocument();
  });

  // Reads are gated, so a section the login cannot read is not somewhere to
  // land on a wall of failed queries: back to the landing page, which shows
  // what they can reach.
  it("redirects a login with no clinical permission back to the landing page", () => {
    renderAt("/clinical/counters", PERMISSION_PRESETS.documents);

    expect(screen.getByRole("heading", { name: "Rota Generator" })).toBeInTheDocument();
    expect(screen.queryByRole("navigation")).not.toBeInTheDocument();
  });
});

describe("the administration section", () => {
  it("renders the users page at /admin/users", async () => {
    server.use(http.get("/api/v1/users", () => HttpResponse.json([])));
    renderAt("/admin/users");

    expect(await screen.findByRole("heading", { name: "Users" })).toBeInTheDocument();
  });

  it("renders the audit log at /admin/audit", async () => {
    server.use(
      http.get("/api/v1/users", () => HttpResponse.json([])),
      http.get("/api/v1/audit", () => HttpResponse.json({ items: [], total: 0 })),
    );
    renderAt("/admin/audit");

    expect(await screen.findByText(/No audit entries match/)).toBeInTheDocument();
  });

  it("redirects a login without the user administration permission away", () => {
    renderAt("/admin/users", PERMISSION_PRESETS.rotaAdmin);

    expect(screen.getByRole("heading", { name: "Rota Generator" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Users" })).not.toBeInTheDocument();
  });

  // The two pages used to live under /clinical. The redirects sit above
  // ClinicalShell so they work for a login that cannot read the clinical
  // section at all - which is exactly the login the permission exists for.
  it.each([
    ["/clinical/users", "Users"],
    ["/clinical/audit", "Audit Log"],
  ])("redirects the old %s path into the admin section", async (path) => {
    server.use(
      http.get("/api/v1/users", () => HttpResponse.json([])),
      http.get("/api/v1/audit", () => HttpResponse.json({ items: [], total: 0 })),
    );
    renderAt(path, {
      ...PERMISSION_PRESETS.documents,
      user_admin: true,
    });

    const nav = await screen.findByRole("navigation");
    expect(within(nav).getByRole("link", { name: "Users" })).toBeInTheDocument();
  });
});

describe("ReceptionShell", () => {
  it("redirects a login with no reception permission back to the landing page", () => {
    renderAt("/reception/counters", PERMISSION_PRESETS.documents);

    expect(screen.getByRole("heading", { name: "Rota Generator" })).toBeInTheDocument();
    expect(screen.queryByRole("navigation")).not.toBeInTheDocument();
  });
});

describe("LandingPage tiles", () => {
  it("offers every section to a login that holds everything", () => {
    renderAt("/");

    for (const label of ["Clinical Rota", "Reception Rota", "Documents", "Administration"]) {
      expect(screen.getByRole("heading", { name: label })).toBeInTheDocument();
    }
  });

  it("offers only what the login can enter", () => {
    renderAt("/", PERMISSION_PRESETS.documents);

    expect(screen.getByRole("heading", { name: "Documents" })).toBeInTheDocument();
    for (const label of ["Clinical Rota", "Reception Rota", "Administration"]) {
      expect(screen.queryByRole("heading", { name: label })).not.toBeInTheDocument();
    }
  });

  // Unreachable through the Users form, which refuses to save a set that
  // grants nothing - but a hand-edited row should say so, not render an
  // empty grid.
  it("explains itself rather than rendering nothing when no section is enterable", () => {
    renderAt("/", {
      clinical: "none",
      reception: "none",
      signatures: false,
      study_eoi: false,
      user_admin: false,
    });

    expect(screen.getByText(/no sections enabled/i)).toBeInTheDocument();
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
  });
});

/**
 * The section editing lock lowers useCanWrite, which roughly twenty
 * components already consult - so the controls go read-only for free. The
 * risk of touching that hook is everything built on the plain
 * canWriteArea() function instead: the nav filter and the route guards,
 * which must keep treating a locked-out writer as the writer they are.
 * Losing the lock must take the buttons away, never the section.
 */
describe("section editing lock", () => {
  const HELD_BY_SOMEONE_ELSE = [
    {
      area: "clinical",
      // Never a fixture user's id, so this always reads as somebody else.
      user_id: -1,
      user_name: "Kristel",
      acquired_at: "2026-01-01T09:00:00Z",
      last_activity_at: "2026-01-01T09:00:00Z",
      idle: false,
    },
  ];

  it("disables the write controls and names the holder", async () => {
    renderAt("/clinical", PERMISSION_PRESETS.rotaAdmin, HELD_BY_SOMEONE_ELSE);

    const gated = await screen.findAllByTitle(editLockTitle("Kristel"));
    expect(gated.length).toBeGreaterThan(0);
    expect(gated[0]).toBeDisabled();
  });

  it("keeps every nav entry a writer normally gets", async () => {
    renderAt("/clinical", PERMISSION_PRESETS.rotaAdmin, HELD_BY_SOMEONE_ELSE);

    await screen.findAllByTitle(editLockTitle("Kristel"));
    const nav = screen.getByRole("navigation");
    for (const label of ["Master Rota", "Clinic Types", "Staff", "Counters"]) {
      expect(within(nav).getByRole("link", { name: label })).toBeInTheDocument();
    }
    // And not the reader's entry, which would mean the lock had been
    // mistaken for a permission.
    expect(within(nav).queryByRole("link", { name: "Committed Rotas" })).not.toBeInTheDocument();
  });

  it("does not redirect a locked-out writer to the reader's home", async () => {
    renderAt("/clinical", PERMISSION_PRESETS.rotaAdmin, HELD_BY_SOMEONE_ELSE);

    expect(await screen.findByRole("heading", { name: "Rota" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Committed rotas" })).not.toBeInTheDocument();
  });

  it("leaves the documents section alone - its permissions cannot be locked", async () => {
    renderAt("/signatures", PERMISSION_PRESETS.manager, HELD_BY_SOMEONE_ELSE);

    expect(await screen.findByRole("heading", { name: "Signatures" })).toBeInTheDocument();
    expect(screen.queryByTitle(editLockTitle("Kristel"))).not.toBeInTheDocument();
  });

  it("stands a banner naming the holder above the page", async () => {
    renderAt("/clinical", PERMISSION_PRESETS.rotaAdmin, HELD_BY_SOMEONE_ELSE);

    const banner = await screen.findByRole("status");
    expect(banner).toHaveTextContent("Kristel");
    expect(banner).toHaveTextContent(/read it, but not make changes/);
  });

  it("carries the banner into the reception section too", async () => {
    renderAt("/reception", PERMISSION_PRESETS.manager, [
      { ...HELD_BY_SOMEONE_ELSE[0], area: "reception" },
    ]);

    const banner = await screen.findByRole("status");
    expect(banner).toHaveTextContent("Kristel");
  });

  it("shows no banner in a section nobody is editing", async () => {
    renderAt("/clinical", PERMISSION_PRESETS.rotaAdmin);

    expect(await screen.findByRole("heading", { name: "Rota" })).toBeInTheDocument();
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  it("explains the read-only section once, not on every page inside it", async () => {
    server.use(
      http.post("/api/v1/locks/:area", () =>
        HttpResponse.json(
          {
            detail: {
              message: "Kristel is editing the clinical rota",
              code: "edit_lock_held",
              area: "clinical",
              holder_user_id: -1,
              holder_name: "Kristel",
              acquired_at: "2026-01-01T09:00:00Z",
              last_activity_at: "2026-01-01T09:00:00Z",
            },
          },
          { status: 409 },
        ),
      ),
    );
    renderAt("/clinical", PERMISSION_PRESETS.rotaAdmin, HELD_BY_SOMEONE_ELSE);

    const dialog = await screen.findByRole("dialog");
    expect(dialog).toHaveTextContent("Kristel is editing the clinical rota");
    await userEvent.click(screen.getByRole("button", { name: "Continue reading" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());

    // Moving to another page in the same section. The shell - and the lock
    // provider around it - stays mounted, so nobody should be told again;
    // the banner is what carries the message from here on.
    await userEvent.click(screen.getByRole("link", { name: "Master Rota" }));

    expect(await screen.findByRole("status")).toHaveTextContent("Kristel");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });
});

/**
 * Logging out has to give the lock back while the token is still valid.
 * Afterwards the session is gone server-side, so the DELETE could only
 * 401 - and a colleague would be told to go and ask somebody who had gone
 * home until the idle timeout ran out.
 */
describe("logout releases the section editing lock", () => {
  afterEach(() => {
    clearToken();
  });

  it("releases before clearing the token", async () => {
    const released: string[] = [];
    server.use(
      http.delete("/api/v1/locks/:area", ({ params }) => {
        released.push(String(params.area));
        return new HttpResponse(null, { status: 204 });
      }),
    );
    setToken("test-token");
    renderAt("/clinical", PERMISSION_PRESETS.rotaAdmin);

    await screen.findByRole("heading", { name: "Rota" });
    await userEvent.click(screen.getByRole("button", { name: "Log out" }));

    await waitFor(() => expect(released).toEqual(["clinical"]));
  });

  it("logs out anyway when the release fails - it is a courtesy, not a gate", async () => {
    let loggedOut = false;
    server.use(
      http.delete("/api/v1/locks/:area", () => HttpResponse.error()),
      http.post("/api/v1/auth/logout", () => {
        loggedOut = true;
        return new HttpResponse(null, { status: 204 });
      }),
    );
    setToken("test-token");
    renderAt("/clinical", PERMISSION_PRESETS.rotaAdmin);

    await screen.findByRole("heading", { name: "Rota" });
    await userEvent.click(screen.getByRole("button", { name: "Log out" }));

    await waitFor(() => expect(loggedOut).toBe(true));
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

  // The two pages are two independent permissions: the section is reachable
  // on either, and the tab bar shows only the one held.
  it("shows only the tab the login holds", async () => {
    renderAt("/signatures", { ...PERMISSION_PRESETS.documents, study_eoi: false });

    expect(await screen.findByRole("heading", { name: "Signatures" })).toBeInTheDocument();
    expect(screen.queryByRole("tab", { name: "Study EOI" })).not.toBeInTheDocument();
  });

  it("lands on the EOI page for a login that holds only that permission", async () => {
    renderAt("/signatures", { ...PERMISSION_PRESETS.documents, signatures: false });

    expect(await screen.findByRole("heading", { name: "Study EOI" })).toBeInTheDocument();
    expect(screen.queryByRole("tab", { name: "Signatures" })).not.toBeInTheDocument();
  });

  it("redirects a login holding neither permission back to the landing page", () => {
    renderAt("/signatures", PERMISSION_PRESETS.readOnly);

    expect(screen.getByRole("heading", { name: "Rota Generator" })).toBeInTheDocument();
    expect(screen.queryByRole("tab", { name: "Signatures" })).not.toBeInTheDocument();
  });
});
