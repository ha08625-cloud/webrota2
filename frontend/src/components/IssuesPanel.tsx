import { useMemo, useState } from "react";

import { useRotaIssues } from "@/api/rota";
import type { Day, Period, ValidationIssue } from "@/api/types";

interface IssuesPanelProps {
  rotaId: number;
  /** Called when the panel navigates to a different week (e.g. an issue
   * on a week not currently shown). RotaDetailPage owns activeWeek state
   * jointly with RotaGrid in Task 4 wiring; for Task 3 this only needs
   * to flip the tab, not coordinate any edit state. */
  onNavigateToWeek?: (week: number) => void;
}

const FLASH_CLASS = "issue-flash";
const FLASH_DURATION_MS = 1500;

/**
 * Human-readable group headers for Phase 12's `check` identifiers. This
 * panel's data source (`GET /rota/:id/issues` -> grid_utils.run_phase12_for_rota)
 * only ever returns Phase 12 checks -- Phase 0 checks abort generation before
 * a grid exists, so they're never fetched here and surface instead as the
 * generate-form 422 list (RotaPage.tsx), which already renders full sentences
 * with no group header. If Phase 12 gains a new check, it will fall back to
 * the raw identifier below rather than fail -- add it here when noticed.
 */
const CHECK_LABELS: Record<string, string> = {
  duty_coverage_primary: "Missing primary duty doctor",
  duty_coverage_secondary: "Missing secondary duty doctor",
  clinic_coverage: "Unfilled clinic slot",
  unresolved_room: "Room not assigned",
  role_on_incompatible_slot: "Role assigned to an incompatible slot",
  supervision_missing: "Trainee supervision missing",
  supervision_on_incompatible_slot: "Invalid supervision assignment",
};

function checkLabel(check: string): string {
  return CHECK_LABELS[check] ?? check;
}

const DAY_ORDER: Record<Day, number> = {
  Monday: 0,
  Tuesday: 1,
  Wednesday: 2,
  Thursday: 3,
  Friday: 4,
};

const PERIOD_ORDER: Record<Period, number> = { AM: 0, PM: 1 };

/**
 * Session order: week, then day, then AM before PM, so a check's issues
 * read in the order the rota is worked through rather than alphabetically
 * by doctor code (which is the order Phase 12 happens to emit them in).
 * Issues with no slot (week/day/period null) sort last, keeping the
 * ordering total. Ties within one session fall back to the message, so
 * two doctors needing a room in the same slot stay alphabetical.
 */
function compareBySession(a: ValidationIssue, b: ValidationIssue): number {
  const aRanks: [number, number, number] = [
    a.week ?? Number.MAX_SAFE_INTEGER,
    a.day === null ? Number.MAX_SAFE_INTEGER : DAY_ORDER[a.day],
    a.period === null ? Number.MAX_SAFE_INTEGER : PERIOD_ORDER[a.period],
  ];
  const bRanks: [number, number, number] = [
    b.week ?? Number.MAX_SAFE_INTEGER,
    b.day === null ? Number.MAX_SAFE_INTEGER : DAY_ORDER[b.day],
    b.period === null ? Number.MAX_SAFE_INTEGER : PERIOD_ORDER[b.period],
  ];
  for (let i = 0; i < aRanks.length; i += 1) {
    if (aRanks[i] !== bRanks[i]) {
      return aRanks[i] - bRanks[i];
    }
  }
  return a.message.localeCompare(b.message);
}

function groupByCheck(issues: ValidationIssue[]): Map<string, ValidationIssue[]> {
  const groups = new Map<string, ValidationIssue[]>();
  for (const issue of issues) {
    const key = issue.check;
    const existing = groups.get(key);
    if (existing) {
      existing.push(issue);
    } else {
      groups.set(key, [issue]);
    }
  }
  for (const checkIssues of groups.values()) {
    checkIssues.sort(compareBySession);
  }
  return groups;
}

export function IssuesPanel({ rotaId, onNavigateToWeek }: IssuesPanelProps) {
  const { data: issues, isLoading, isError } = useRotaIssues(rotaId);
  const grouped = useMemo(() => groupByCheck(issues ?? []), [issues]);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  if (isLoading) {
    return <p className="text-sm text-ink/70">Loading issues...</p>;
  }
  if (isError) {
    return <p className="text-sm text-red-700">Could not load validation issues.</p>;
  }
  if (!issues || issues.length === 0) {
    return <p className="text-sm text-ink/50">No validation issues.</p>;
  }

  function toggle(check: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(check)) {
        next.delete(check);
      } else {
        next.add(check);
      }
      return next;
    });
  }

  function navigateTo(issue: ValidationIssue) {
    if (issue.week === null || issue.day === null || issue.period === null) {
      return;
    }
    onNavigateToWeek?.(issue.week);
    const target = document.querySelector<HTMLElement>(
      `[data-week-day-period="${issue.week}-${issue.day}-${issue.period}"]`,
    );
    if (target === null) {
      return;
    }
    target.scrollIntoView({ behavior: "smooth", block: "center" });
    target.classList.add(FLASH_CLASS);
    setTimeout(() => target.classList.remove(FLASH_CLASS), FLASH_DURATION_MS);
  }

  return (
    <aside className="w-72 shrink-0 border-l border-border p-3">
      <h2 className="text-sm font-semibold">Validation issues</h2>
      <ul className="mt-2 space-y-2">
        {[...grouped.entries()].map(([check, checkIssues]) => (
          <li key={check}>
            <button
              type="button"
              onClick={() => toggle(check)}
              className="flex w-full items-center justify-between text-left text-sm font-medium text-ink/80"
              aria-expanded={expanded.has(check)}
            >
              <span>{checkLabel(check)}</span>
              <span className="text-xs text-ink/50">{checkIssues.length}</span>
            </button>
            {expanded.has(check) ? (
              <ul className="mt-1 space-y-1 pl-2">
                {checkIssues.map((issue, index) => {
                  const navigable = issue.week !== null && issue.day !== null && issue.period !== null;
                  return (
                    <li key={index}>
                      {navigable ? (
                        <button
                          type="button"
                          onClick={() => navigateTo(issue)}
                          className="text-left text-xs text-accent underline-offset-2 hover:underline"
                        >
                          {issue.message}
                        </button>
                      ) : (
                        <span className="text-xs text-ink/70">{issue.message}</span>
                      )}
                    </li>
                  );
                })}
              </ul>
            ) : null}
          </li>
        ))}
      </ul>
    </aside>
  );
}