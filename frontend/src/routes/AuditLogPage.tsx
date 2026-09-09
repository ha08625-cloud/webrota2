import { useState } from "react";

import { useAuditLog } from "@/api/audit";
import { useDoctors } from "@/api/doctors";
import { useUsers } from "@/api/users";
import type { AuditLogEntry, AuditLogFilters } from "@/api/types";
import { useCanAdminUsers } from "@/auth/AuthContext";
import {
  describeAuditBody,
  outcomeClass,
  summariseAuditBody,
  type AuditLookups,
} from "@/lib/auditDetails";
import { formatDateTime } from "@/lib/date";

/** Fixed page size. The backend caps `limit` at 200; 50 keeps a page scannable. */
const PAGE_SIZE = 50;

/**
 * The HTTP method filter, labelled as the thing it means rather than as
 * itself: the reader of this page should not have to know what PATCH is.
 *
 * Reads are not audited at all - this app holds staff scheduling data, not
 * patient data, so a read log would be noise - so these are the only
 * methods that can appear. Listed explicitly rather than derived from the
 * rows on screen, so the filter does not change shape as you page.
 */
const ACTIONS = [
  { value: "POST", label: "Added or ran" },
  { value: "PATCH", label: "Changed" },
  { value: "PUT", label: "Replaced" },
  { value: "DELETE", label: "Deleted" },
] as const;

/**
 * The status filter, as three buckets over the same `status_min`/
 * `status_max` range the backend already takes. A free-text status code
 * box is the more powerful control and was the previous one; it is also
 * unusable by the person this page exists for, and the exact code is
 * still on every row's expanded detail for anyone debugging.
 */
const OUTCOMES = [
  { value: "", label: "All outcomes", min: undefined, max: undefined },
  { value: "ok", label: "Successful only", min: 200, max: 399 },
  { value: "problem", label: "Problems only", min: 400, max: 599 },
] as const;

export function AuditLogPage() {
  // Matching the backend, where the whole /audit router is gated on the
  // user administration permission - reads included, so without it this
  // would be a bare "Could not load". AdminShell redirects such a login
  // away; this covers the page being mounted outside it.
  const canAdminUsers = useCanAdminUsers();

  if (!canAdminUsers) {
    return (
      <div>
        <h1 className="text-lg font-semibold">Audit Log</h1>
        <p className="mt-4 text-sm text-ink/70">
          You do not have access to the audit log. Ask a user administrator if you need to know
          what changed.
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
  outcome: string;
  since: string;
  until: string;
}

const EMPTY_DRAFT: FilterDraft = {
  pathContains: "",
  method: "",
  userId: "",
  outcome: "",
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
  const outcome = OUTCOMES.find((o) => o.value === draft.outcome);
  return {
    path_contains: draft.pathContains.trim() || undefined,
    method: draft.method || undefined,
    user_id: parseIntOrUndefined(draft.userId),
    status_min: outcome?.min,
    status_max: outcome?.max,
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

  // Both are name lookups only - they label the user filter and turn ids
  // inside request bodies into codes and names. Neither is required for
  // the log to render: a login with user administration but no clinical
  // read gets a 403 from /doctors, and the ids simply stay ids.
  const { data: users } = useUsers();
  const { data: doctors } = useDoctors();

  const lookups: AuditLookups = {
    userNames: new Map((users ?? []).map((u) => [u.id, u.name])),
    doctorCodes: new Map((doctors ?? []).map((d) => [d.id, d.code])),
  };

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
        One entry for every change anyone made. Viewing is not recorded, only changes. Each entry
        describes what was <em>attempted</em>; the Outcome column says whether it worked.
      </p>

      <form
        onSubmit={handleApply}
        aria-label="Audit log filters"
        className="mt-4 flex flex-wrap items-end gap-2 rounded border border-border p-3"
      >
        <div>
          <label className="block text-xs font-medium text-ink/70" htmlFor="audit-user">
            Who
          </label>
          <select
            id="audit-user"
            value={draft.userId}
            onChange={(e) => updateDraft("userId", e.target.value)}
            className="mt-1 rounded border border-border p-1 text-sm"
          >
            <option value="">Anyone</option>
            {(users ?? []).map((u) => (
              <option key={u.id} value={String(u.id)}>
                {u.name}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className="block text-xs font-medium text-ink/70" htmlFor="audit-method">
            Action
          </label>
          <select
            id="audit-method"
            value={draft.method}
            onChange={(e) => updateDraft("method", e.target.value)}
            className="mt-1 rounded border border-border p-1 text-sm"
          >
            <option value="">Any action</option>
            {ACTIONS.map((action) => (
              <option key={action.value} value={action.value}>
                {action.label}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className="block text-xs font-medium text-ink/70" htmlFor="audit-outcome">
            Outcome
          </label>
          <select
            id="audit-outcome"
            value={draft.outcome}
            onChange={(e) => updateDraft("outcome", e.target.value)}
            className="mt-1 rounded border border-border p-1 text-sm"
          >
            {OUTCOMES.map((outcome) => (
              <option key={outcome.value} value={outcome.value}>
                {outcome.label}
              </option>
            ))}
          </select>
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
        <div>
          <label className="block text-xs font-medium text-ink/70" htmlFor="audit-path">
            Address contains
          </label>
          <input
            id="audit-path"
            type="text"
            value={draft.pathContains}
            onChange={(e) => updateDraft("pathContains", e.target.value)}
            placeholder="/rota/12/"
            className="mt-1 rounded border border-border p-1 text-sm"
            aria-describedby="audit-path-help"
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
        <p id="audit-path-help" className="w-full text-xs text-ink/50">
          Address contains is for narrowing to one record - <code>/rota/12/</code> shows everything
          that touched rota 12. It is a plain substring match, so <code>/rota/12</code> without the
          trailing slash also matches <code>/rota/120</code>.
        </p>
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
                <th className="py-1 pr-4 font-medium">Who</th>
                <th className="py-1 pr-4 font-medium">What happened</th>
                <th className="py-1 pr-4 font-medium">Details</th>
                <th className="py-1 pr-4 font-medium">Outcome</th>
                <th className="py-1" />
              </tr>
            </thead>
            <tbody>
              {items.map((entry) => (
                <AuditRow key={entry.id} entry={entry} lookups={lookups} />
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
 * The person who made the change, by name where one can be found.
 *
 * `user_email` is a frozen snapshot taken at write time, so it still reads
 * correctly after a rename or a deletion; the name is a live lookup and is
 * only a nicer label for it. Neither exists for an unauthenticated
 * request - a failed login, typically - which is what the dash means.
 */
function actorName(entry: AuditLogEntry, lookups: AuditLookups): string | null {
  const byId = entry.user_id === null ? undefined : lookups.userNames?.get(entry.user_id);
  return byId ?? entry.user_email;
}

function AuditRow({ entry, lookups }: { entry: AuditLogEntry; lookups: AuditLookups }) {
  const [expanded, setExpanded] = useState(false);
  const who = actorName(entry, lookups);
  const fields = describeAuditBody(entry.request_body, lookups);

  return (
    <>
      <tr className="border-t border-border align-top">
        <td className="py-1 pr-4 whitespace-nowrap">{formatDateTime(entry.at)}</td>
        <td className="py-1 pr-4">{who ?? <span className="text-ink/50">-</span>}</td>
        {/* Server-derived, so the wording is one table rather than one per
            client, and a reworded sentence improves historical rows too. */}
        <td className="py-1 pr-4">{entry.summary}</td>
        {/* What a change was set *to* is the column that makes this page
            worth having, so it stays on the row rather than hiding
            entirely behind the expander. */}
        <td className="py-1 pr-4 text-ink/70">{summariseAuditBody(entry.request_body, lookups)}</td>
        <td className={`py-1 pr-4 ${outcomeClass(entry.outcome)}`}>{entry.outcome}</td>
        <td className="py-1">
          <button
            type="button"
            onClick={() => setExpanded((e) => !e)}
            aria-expanded={expanded}
            className="text-xs text-accent"
          >
            {expanded ? "Hide" : "More"}
          </button>
        </td>
      </tr>
      {expanded ? (
        <tr className="border-t border-border/50">
          <td colSpan={6} className="py-2">
            <dl className="grid gap-1 text-xs">
              {fields.map((field) => (
                <DetailRow key={field.label} label={field.label} value={field.value} />
              ))}
              {entry.outcome_detail ? (
                <DetailRow label="Reason" value={entry.outcome_detail} />
              ) : null}
              {/* Everything below is for whoever is debugging rather than
                  reading, which is why it is last and why the readable
                  fields above are not a rendering of it. */}
              <DetailRow label="Address" value={`${entry.method} ${entry.path}`} mono />
              <DetailRow label="Status code" value={String(entry.status_code)} mono />
              <DetailRow
                label="Took"
                value={entry.duration_ms === null ? "-" : `${entry.duration_ms} ms`}
              />
              <DetailRow label="From computer" value={entry.client_ip ?? "-"} mono />
            </dl>
          </td>
        </tr>
      ) : null}
    </>
  );
}

function DetailRow({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex gap-2">
      <dt className="w-32 shrink-0 font-medium text-ink/70">{label}</dt>
      <dd className={`min-w-0 flex-1 whitespace-pre-wrap break-words ${mono ? "font-mono" : ""}`}>
        {value}
      </dd>
    </div>
  );
}
