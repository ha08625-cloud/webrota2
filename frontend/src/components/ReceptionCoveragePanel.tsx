import type { ValidationIssue } from "@/api/types";

interface ReceptionCoveragePanelProps {
  /**
   * The day rota's current coverage shortfall warnings - passed in from
   * the page's current GET/mutation response, never fetched separately
   * here. Every mutating day-rota endpoint already returns freshly
   * recomputed issues alongside the written session (reception rota
   * plan, Task 8), which is what lets the page splice a mutation
   * response straight into this panel with no second request.
   */
  issues: ValidationIssue[];
}

/**
 * Lists the day rota's coverage warnings. Sibling of IssuesPanel in
 * presentation only (a grouped list of messages) - not a generalisation
 * of it, since every issue here is severity="warning" and none can block
 * a save (coverage is a read-time derivation, never an
 * error). Deliberately avoids IssuesPanel's error-adjacent styling and
 * wording (red backgrounds, "issues") in favour of amber and "coverage",
 * so a shortfall reads as a heads-up, not a failure.
 */
export function ReceptionCoveragePanel({ issues }: ReceptionCoveragePanelProps) {
  return (
    <aside className="w-72 shrink-0 rounded-lg border border-border bg-surface p-4 shadow-sm">
      <h2 className="text-xs font-semibold uppercase tracking-wide text-ink/50">Coverage</h2>
      {issues.length === 0 ? (
        <p className="mt-2 text-sm text-ink/50">No coverage shortfalls.</p>
      ) : (
        <ul className="mt-2 space-y-1">
          {issues.map((issue, index) => (
            <li key={index} className="rounded-md bg-amber-50 px-2 py-1.5 text-sm text-amber-800">
              {issue.message}
            </li>
          ))}
        </ul>
      )}
    </aside>
  );
}
