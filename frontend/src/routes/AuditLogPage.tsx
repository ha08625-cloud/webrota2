import { useState } from "react";

import { useAuditLog } from "@/api/audit";
import { useUsers } from "@/api/users";
import type { AuditLogEntry, AuditLogFilters } from "@/api/types";
import { useIsManager } from "@/auth/AuthContext";
import { formatDateTime } from "@/lib/date";

/** Fixed page size. The backend caps `limit` at 200; 50 keeps a page scannable. */
const PAGE_SIZE = 50;

/**
 * Reads are not audited at all - this app holds staff scheduling data, not
 * patient data, so a read log would be noise - so these are the only
 * methods that can appear. Listed explicitly rather than derived from the
 * rows on screen, so the filter does not change shape as you page.
 */
const METHODS = ["POST", "PATCH", "PUT", "DELETE"] as const;

export function AuditLogPage() {
  // Manager-only, matching the backend: the whole /audit router hangs off
  // require_manager, so a lower tier would otherwise get a bare "Could not
  // load". The nav entry is hidden for them too (App.tsx), but the route
  // stays registered so a bookmarked link lands somewhere sane.
  const isManager = useIsManager();

  if (!isManager) {
    return (
      <div>
        <h1 className="text-lg font-semibold">Audit Log</h1>
        <p className="mt-4 text-sm text-ink/70">
          You do not have access to the audit log. Ask a manager if you need to know what changed.
        </p>
      </div>
    );
  }

  return <AuditLogTable />;
}

/** The draft filter form's state: every field is a string, as typed. */
interface FilterDraft {
  pathContains: string;
  method: string;
  userId: string;
  statusMin: string;
  statusMax: string;
  since: string;
  until: string;
}

const EMPTY_DRAFT: FilterDraft = {
  pathContains: "",
  method: "",
  userId: "",
  statusMin: "",
  statusMax: "",
  since: "",
  until: "",
};

function parseIntOrUndefined(value: string): number | undefined {
  const parsed = Number.parseInt(value, 10);
  return Number.isNaN(parsed) ? undefined : parsed;
}

/**
 * Turns the form's strings into query parameters. The date inputs are
 * date-only, but `since`/`until` are inclusive datetime bounds, so `until`
 * has to reach the end of the day it names - otherwise picking today as the
 * end date silently excludes everything that happened today.
 *
 * No timezone offset is attached: the backend stores and compares `at` as
 * wall-clock UTC (SQLite does not round-trip tzinfo), so sending a local
 * offset would be filtering against a value the server does not hold.
 */
function toFilters(draft: FilterDraft): AuditLogFilters {
  return {
    path_contains: draft.pathContains.trim() || undefined,
    method: draft.method || undefined,
    user_id: parseIntOrUndefined(draft.userId),
    status_min: parseIntOrUndefined(draft.statusMin),
    status_max: parseIntOrUndefined(draft.statusMax),
    since: draft.since ? `${draft.since}T00:00:00` : undefined,
    until: draft.until ? `${draft.until}T23:59:59` : undefined,
  };
}

function AuditLogTable() {
  const [draft, setDraft] = useState<FilterDraft>(EMPTY_DRAFT);
  // Applied separately from the draft so that typing in the path box does
  // not fire a request per keystroke - each one is a full table scan
  // server-side (no index behind the substring filter, by design).
  const [applied, setApplied] = useState<AuditLogFilters>({});
  const [offset, setOffset] = useState(0);

  const { data, isLoading, isError, isPlaceholderData } = useAuditLog({
    ...applied,
    limit: PAGE_SIZE,
    offset,
  });

  // Only to label the user filter and nothing else; if it fails the filter
  // just falls back to "All users" and the log itself still renders.
  const { data: users } = useUsers();

  function updateDraft(field: keyof FilterDraft, value: string) {
    setDraft((d) => ({ ...d, [field]: value }));
  }

  function handleApply(e: React.FormEvent) {
    e.preventDefault();
    setApplied(toFilters(draft));
    // Back to page one: an offset carried over from the previous filter
    // set usually lands past the end of the new one, showing nothing.
    setOffset(0);
  }

  function handleClear() {
    setDraft(EMPTY_DRAFT);
    setApplied({});
    setOffset(0);
  }

  const items = data?.items ?? [];
  const total = data?.total ?? 0;
  const rangeStart = total === 0 ? 0 : offset + 1;
  const rangeEnd = offset + items.length;
  const hasNext = rangeEnd < total;

  return (
    <div>
      <h1 className="text-lg font-semibold">Audit Log</h1>
      <p className="mt-1 text-sm text-ink/70">
        One entry per write request. Reads are not recorded. To follow one rota, filter the path by{" "}
        <code>/rota/12/</code> - it is a plain substring match, so <code>/rota/12</code> without the
        trailing slash also matches <code>/rota/120</code>.
      </p>

      <form
        onSubmit={handleApply}
        aria-label="Audit log filters"
        className="mt-4 flex flex-wrap items-end gap-2 rounded border border-border p-3"
      >
        <div>
          <label className="block text-xs font-medium text-ink/70" htmlFor="audit-path">
            Path contains
          </label>
          <input
            id="audit-path"
            type="text"
            value={draft.pathContains}
            onChange={(e) => updateDraft("pathContains", e.target.value)}
            placeholder="/rota/12/"
            className="mt-1 rounded border border-border p-1 text-sm"
          />
        </div>
        <div>
          <label className="block text-xs font-medium text-ink/70" htmlFor="audit-method">
            Method
          </label>
          <select
            id="audit-method"
            value={draft.method}
            onChange={(e) => updateDraft("method", e.target.value)}
            className="mt-1 rounded border border-border p-1 text-sm"
          >
            <option value="">All methods</option>
            {METHODS.map((method) => (
              <option key={method} value={method}>
                {method}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className="block text-xs font-medium text-ink/70" htmlFor="audit-user">
            User
          </label>
          <select
            id="audit-user"
            value={draft.userId}
            onChange={(e) => updateDraft("userId", e.target.value)}
            className="mt-1 rounded border border-border p-1 text-sm"
          >
            <option value="">All users</option>
            {(users ?? []).map((u) => (
              <option key={u.id} value={String(u.id)}>
                {u.name}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className="block text-xs font-medium text-ink/70" htmlFor="audit-status-min">
            Status from
          </label>
          <input
            id="audit-status-min"
            type="number"
            value={draft.statusMin}
            onChange={(e) => updateDraft("statusMin", e.target.value)}
            placeholder="400"
            className="mt-1 w-20 rounded border border-border p-1 text-sm"
          />
        </div>
        <div>
          <label className="block text-xs font-medium text-ink/70" htmlFor="audit-status-max">
            Status to
          </label>
          <input
            id="audit-status-max"
            type="number"
            value={draft.statusMax}
            onChange={(e) => updateDraft("statusMax", e.target.value)}
            placeholder="599"
            className="mt-1 w-20 rounded border border-border p-1 text-sm"
          />
        </div>
        <div>
          <label className="block text-xs font-medium text-ink/70" htmlFor="audit-since">
            From
          </label>
          <input
            id="audit-since"
            type="date"
            value={draft.since}
            onChange={(e) => updateDraft("since", e.target.value)}
            className="mt-1 rounded border border-border p-1 text-sm"
          />
        </div>
        <div>
          <label className="block text-xs font-medium text-ink/70" htmlFor="audit-until">
            To
          </label>
          <input
            id="audit-until"
            type="date"
            value={draft.until}
            onChange={(e) => updateDraft("until", e.target.value)}
            className="mt-1 rounded border border-border p-1 text-sm"
          />
        </div>
        <button
          type="submit"
          className="rounded bg-accent px-4 py-1 text-sm font-medium text-white"
        >
          Apply
        </button>
        <button
          type="button"
          onClick={handleClear}
          className="rounded border border-border px-4 py-1 text-sm"
        >
          Clear
        </button>
      </form>

      {isLoading ? <p className="mt-4 text-sm text-ink/70">Loading...</p> : null}
      {isError ? <p className="mt-4 text-sm text-red-700">Could not load the audit log.</p> : null}

      {data && items.length === 0 ? (
        <p className="mt-4 text-sm text-ink/50">No audit entries match these filters.</p>
      ) : null}

      {items.length > 0 ? (
        // Dimmed while the next page is in flight: keepPreviousData leaves
        // the previous page on screen rather than flashing empty, so
        // without this there is no sign anything is happening.
        <div className={isPlaceholderData ? "opacity-60" : undefined}>
          <table aria-label="Audit log" className="mt-4 min-w-full text-sm">
            <thead>
              <tr className="text-left text-ink/70">
                <th className="py-1 pr-4 font-medium">When</th>
                <th className="py-1 pr-4 font-medium">User</th>
                <th className="py-1 pr-4 font-medium">Method</th>
                <th className="py-1 pr-4 font-medium">Path</th>
                <th className="py-1 pr-4 font-medium">Status</th>
                <th className="py-1 pr-4 font-medium">Sent</th>
                <th className="py-1" />
              </tr>
            </thead>
            <tbody>
              {items.map((entry) => (
                <AuditRow key={entry.id} entry={entry} />
              ))}
            </tbody>
          </table>
        </div>
      ) : null}

      {items.length > 0 ? (
        <div className="mt-4 flex items-center gap-3 text-sm">
          <button
            type="button"
            onClick={() => setOffset((o) => Math.max(0, o - PAGE_SIZE))}
            disabled={offset === 0 || isPlaceholderData}
            className="rounded border border-border px-3 py-1 disabled:opacity-50"
          >
            Previous
          </button>
          <span className="text-ink/70">
            {rangeStart}-{rangeEnd} of {total}
          </span>
          <button
            type="button"
            onClick={() => setOffset((o) => o + PAGE_SIZE)}
            disabled={!hasNext || isPlaceholderData}
            className="rounded border border-border px-3 py-1 disabled:opacity-50"
          >
            Next
          </button>
        </div>
      ) : null}
    </div>
  );
}

/**
 * A one-line preview of a JSON value for the table cell. The full value is
 * behind the row's expander - this is only enough to tell two rows apart at
 * a glance without making every row wrap.
 */
function summarise(value: unknown, maxLength = 60): string {
  if (value === null || value === undefined) {
    return "";
  }
  const text = JSON.stringify(value);
  return text.length > maxLength ? `${text.slice(0, maxLength)}...` : text;
}

function AuditRow({ entry }: { entry: AuditLogEntry }) {
  const [expanded, setExpanded] = useState(false);
  const hasDetail =
    entry.request_body !== null || entry.path_params !== null || entry.outcome_detail !== null;

  return (
    <>
      <tr className="border-t border-border align-top">
        <td className="py-1 pr-4 whitespace-nowrap">{formatDateTime(entry.at)}</td>
        {/* The email is a frozen snapshot taken at write time, not a join,
            so it still reads correctly after a rename. Blank means there
            was no authenticated user - a failed login, typically. */}
        <td className="py-1 pr-4">{entry.user_email ?? <span className="text-ink/50">-</span>}</td>
        <td className="py-1 pr-4">{entry.method}</td>
        <td className="py-1 pr-4 font-mono text-xs">{entry.path}</td>
        <td className={`py-1 pr-4 ${entry.status_code >= 400 ? "text-red-700" : ""}`}>
          {entry.status_code}
        </td>
        {/* The request body is the column that makes this page worth
            having - what a change was set *to* - so it gets its own
            column rather than hiding behind the expander entirely. */}
        <td className="py-1 pr-4 font-mono text-xs">{summarise(entry.request_body)}</td>
        <td className="py-1">
          {hasDetail ? (
            <button
              type="button"
              onClick={() => setExpanded((e) => !e)}
              aria-expanded={expanded}
              className="text-xs text-accent"
            >
              {expanded ? "Hide" : "Details"}
            </button>
          ) : null}
        </td>
      </tr>
      {expanded ? (
        <tr className="border-t border-border/50">
          <td colSpan={7} className="py-2">
            <dl className="grid gap-1 text-xs">
              <DetailRow label="Route" value={entry.route ?? "-"} />
              <DetailRow label="Path params" value={JSON.stringify(entry.path_params)} />
              <DetailRow label="Request body" value={JSON.stringify(entry.request_body, null, 2)} />
              {entry.outcome_detail ? (
                <DetailRow label="Outcome" value={entry.outcome_detail} />
              ) : null}
              <DetailRow
                label="Duration"
                value={entry.duration_ms === null ? "-" : `${entry.duration_ms} ms`}
              />
              <DetailRow label="Client IP" value={entry.client_ip ?? "-"} />
            </dl>
          </td>
        </tr>
      ) : null}
    </>
  );
}

function DetailRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex gap-2">
      <dt className="w-28 shrink-0 font-medium text-ink/70">{label}</dt>
      <dd className="min-w-0 flex-1 whitespace-pre-wrap break-all font-mono">{value}</dd>
    </div>
  );
}
