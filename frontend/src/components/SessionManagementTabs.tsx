import { NavLink, Outlet, useLocation } from "react-router-dom";

/**
 * The session-planning pages, grouped behind one "Session Management" entry
 * in the clinical left nav (App.tsx) and switched between with the sub-tab
 * bar below. Paths are absolute and deliberately unchanged from when these
 * were five separate top-level nav entries - the grouping is presentational
 * only, so nothing that links to or bookmarks them had to move.
 *
 * Exported because App.tsx needs both the first tab (where the parent nav
 * entry points) and the full path set (to light that entry up on any of the
 * five, which NavLink's own isActive cannot do for sibling paths).
 *
 * Labels differ from the component names behind them - "Annual Planner" is
 * LeavePlanningPage, "Individual Leave" is LeavePage. See the label/file
 * mapping note in documentation/architecture-clinical.md.
 */
export const SESSION_MANAGEMENT_TABS = [
  { to: "/clinical/leave-planning", label: "Annual Planner" },
  { to: "/clinical/leave", label: "Individual Leave" },
  { to: "/clinical/extra-sessions", label: "Extra Sessions" },
  { to: "/clinical/closures", label: "Closures" },
  { to: "/clinical/school-holidays", label: "School Holidays" },
] as const;

export const SESSION_MANAGEMENT_PATHS: readonly string[] = SESSION_MANAGEMENT_TABS.map(
  (tab) => tab.to,
);

/**
 * Horizontal sub-tab strip, same visual treatment as WeekTabs. Active tab is
 * derived from the current pathname rather than tracked in state - the router
 * is the only source of truth for which page is showing.
 */
export function SessionManagementTabs() {
  const { pathname } = useLocation();

  return (
    <div className="flex gap-1 border-b border-border" role="tablist" aria-label="Session management">
      {SESSION_MANAGEMENT_TABS.map((tab) => {
        const isActive = pathname === tab.to;

        return (
          <NavLink
            key={tab.to}
            to={tab.to}
            role="tab"
            aria-selected={isActive}
            className={`px-4 py-2 text-sm font-medium ${
              isActive ? "border-b-2 border-accent text-accent" : "text-ink/60 hover:text-ink"
            }`}
          >
            {tab.label}
          </NavLink>
        );
      })}
    </div>
  );
}

/**
 * Layout route wrapping the five pages, so the tab bar lives in exactly one
 * place and cannot drift out of sync with the pages it labels. The tabbed
 * pages own no heading of their own - the active tab names the page.
 */
export function SessionManagementLayout() {
  return (
    <div>
      <SessionManagementTabs />
      <div className="mt-4">
        <Outlet />
      </div>
    </div>
  );
}
