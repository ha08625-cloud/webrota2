import { createContext, useCallback, useContext, useMemo, useState } from "react";
import type { ReactNode } from "react";

import { NavLink, Outlet, useLocation, useSearchParams } from "react-router-dom";

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
 * School Holidays is the one tab a calendar year cannot filter: term dates
 * straddle New Year, so a year filter would cut most holidays in half. It
 * keeps its own "show past holidays" checkbox and hides the year control.
 */
const YEARLESS_PATHS: readonly string[] = ["/clinical/school-holidays"];

/** How far either side of the current year the control (and a pasted URL)
 * may reach. Purely a guard against a typo'd `?year=20027` firing queries
 * for a year with nothing in it. */
const YEAR_RANGE = 5;

export function sessionYearBounds(today: Date = new Date()): { min: number; max: number } {
  const currentYear = today.getFullYear();
  return { min: currentYear - YEAR_RANGE, max: currentYear + YEAR_RANGE };
}

/**
 * Reads the `year` search param. Anything missing, non-numeric or outside
 * the supported range reads as the current year rather than erroring - a
 * hand-edited URL should land somewhere sensible, not on an empty page.
 */
export function parseSessionYear(raw: string | null | undefined, today: Date = new Date()): number {
  const currentYear = today.getFullYear();
  if (raw === null || raw === undefined || !/^\d+$/.test(raw.trim())) return currentYear;

  const { min, max } = sessionYearBounds(today);
  const parsed = Number(raw);
  return parsed < min || parsed > max ? currentYear : parsed;
}

interface SessionYearContextValue {
  year: number;
  /** 1-12. Only the Annual Planner reads it, but it lives here so that
   * switching tabs and back does not throw away the month you were on. */
  month: number;
  /** Selects a year and resets the month to today's month within it. */
  setYear: (year: number) => void;
  /** Sets the month, optionally moving the year with it - that is how the
   * planner writes a December -> January step back to the strip. */
  setMonth: (month: number, year?: number) => void;
}

const SessionYearContext = createContext<SessionYearContextValue | null>(null);

/**
 * Owns the year shared by the Session Management sub-tabs. The URL is the
 * source of truth for the year (`?year=2027`), so a pasted link opens on the
 * same year and back/forward work; the month is session state only, to keep
 * the query string on the other four tabs clean.
 */
export function SessionYearProvider({ children }: { children: ReactNode }) {
  const [searchParams, setSearchParams] = useSearchParams();
  const year = parseSessionYear(searchParams.get("year"));
  const [month, setMonthState] = useState(() => new Date().getMonth() + 1);

  const writeYear = useCallback(
    (next: number) => {
      const { min, max } = sessionYearBounds();
      const clamped = Math.min(Math.max(next, min), max);
      setSearchParams(
        (prev) => {
          const params = new URLSearchParams(prev);
          params.set("year", String(clamped));
          return params;
        },
        // Year paging is a filter, not a navigation - it should not fill the
        // back stack with every year the user clicked through.
        { replace: true },
      );
    },
    [setSearchParams],
  );

  const value = useMemo<SessionYearContextValue>(
    () => ({
      year,
      month,
      setYear: (next: number) => {
        writeYear(next);
        setMonthState(new Date().getMonth() + 1);
      },
      setMonth: (nextMonth: number, nextYear?: number) => {
        setMonthState(nextMonth);
        if (nextYear !== undefined && nextYear !== year) writeYear(nextYear);
      },
    }),
    [year, month, writeYear],
  );

  return <SessionYearContext.Provider value={value}>{children}</SessionYearContext.Provider>;
}

/**
 * The shared year, or a read-only current year outside the provider. The
 * fallback is what lets each page's own tests render it standalone, without
 * a router and provider wrapped around every case.
 */
export function useSessionYear(): SessionYearContextValue {
  const context = useContext(SessionYearContext);
  const now = new Date();
  return (
    context ?? {
      year: now.getFullYear(),
      month: now.getMonth() + 1,
      setYear: () => {},
      setMonth: () => {},
    }
  );
}

/**
 * The one year control for all five tabs. It sits above the tabs rather than
 * on a page, because a per-page control that silently changed four other
 * tabs would read as a trap.
 */
export function SessionYearControl() {
  const { year, setYear } = useSessionYear();
  const { min, max } = sessionYearBounds();

  return (
    <div className="flex items-center gap-2 pb-1">
      <button
        type="button"
        onClick={() => setYear(year - 1)}
        disabled={year <= min}
        className="rounded border border-border px-2 text-sm disabled:opacity-50"
        aria-label="Previous year"
      >
        &lt;
      </button>
      <span className="text-sm tabular-nums">{year}</span>
      <button
        type="button"
        onClick={() => setYear(year + 1)}
        disabled={year >= max}
        className="rounded border border-border px-2 text-sm disabled:opacity-50"
        aria-label="Next year"
      >
        &gt;
      </button>
    </div>
  );
}

/**
 * Horizontal sub-tab strip, same visual treatment as WeekTabs. Active tab is
 * derived from the current pathname rather than tracked in state - the router
 * is the only source of truth for which page is showing. Tab links carry the
 * selected year, so switching tabs stays on the year you were looking at.
 */
export function SessionManagementTabs() {
  const { pathname } = useLocation();
  const { year } = useSessionYear();

  return (
    <div className="flex items-end justify-between border-b border-border">
      <div className="flex gap-1" role="tablist" aria-label="Session management">
        {SESSION_MANAGEMENT_TABS.map((tab) => {
          const isActive = pathname === tab.to;

          return (
            <NavLink
              key={tab.to}
              to={{ pathname: tab.to, search: `?year=${year}` }}
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
      {YEARLESS_PATHS.includes(pathname) ? null : <SessionYearControl />}
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
    <SessionYearProvider>
      <div>
        <SessionManagementTabs />
        <div className="mt-4">
          <Outlet />
        </div>
      </div>
    </SessionYearProvider>
  );
}
