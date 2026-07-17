import { useMemo, useState, type FormEvent } from "react";
import { Link, useNavigate } from "react-router-dom";

import { useClinicTypes } from "@/api/clinicTypes";
import { useClosures } from "@/api/closures";
import { useDuty } from "@/api/duty";
import { useGenerateRota, useRotaList } from "@/api/rota";
import type { ApiError, FastApiValidationError, GenerateRotaIn, ValidationIssue } from "@/api/types";
import { addDays, formatDate, formatDateTime, formatWeekLabel, getUpcomingMondays } from "@/lib/date";
import { isDutyWeekComplete } from "@/lib/dutyWeekComplete";

const UPCOMING_WEEK_COUNT = 12;

function isValidationIssueList(detail: unknown): detail is ValidationIssue[] {
  return (
    Array.isArray(detail) &&
    detail.length > 0 &&
    detail.every((item) => typeof item === "object" && item !== null && "message" in item)
  );
}

function isFastApiErrorList(detail: unknown): detail is FastApiValidationError[] {
  return (
    Array.isArray(detail) &&
    detail.length > 0 &&
    detail.every((item) => typeof item === "object" && item !== null && "msg" in item)
  );
}

/**
 * Renders whichever of the three shapes a failed /rota/generate call can
 * come back as: a plain-string 409 (draft already exists), a list of
 * Phase 0 ValidationIssues (business-logic 422), or a list of standard
 * FastAPI request-validation errors (422 from a body Pydantic itself
 * rejected - shouldn't happen given the client-side checks, but the
 * client-side checks aren't the source of truth, so this is handled
 * rather than assumed away).
 */
function GenerateErrorMessage({ error }: { error: ApiError }) {
  if (isValidationIssueList(error.detail)) {
    return (
      <div className="mt-3 rounded border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-800">
        <p className="font-medium">Generation failed:</p>
        <ul className="mt-1 list-inside list-disc">
          {error.detail.map((issue, index) => (
            <li key={index}>
              {issue.message}
              {issue.week !== null && issue.day !== null
                ? ` (week ${issue.week}, ${issue.day}${issue.period ? ` ${issue.period}` : ""})`
                : ""}
            </li>
          ))}
        </ul>
      </div>
    );
  }

  if (isFastApiErrorList(error.detail)) {
    return (
      <div className="mt-3 rounded border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-800">
        <p className="font-medium">Invalid request:</p>
        <ul className="mt-1 list-inside list-disc">
          {error.detail.map((item, index) => (
            <li key={index}>{item.msg}</li>
          ))}
        </ul>
      </div>
    );
  }

  return (
    <p className="mt-3 rounded border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-800">
      {typeof error.detail === "string" ? error.detail : "Something went wrong generating the rota."}
    </p>
  );
}

/**
 * Advisory duty-staffing status for every week the selected (startDate,
 * numWeeks) combination would cover - read-only, matches the marker
 * already shown on the Duty page (same isDutyWeekComplete rule, now
 * including closures - see below), so a user picking a start week can
 * see up front whether duty still needs filling in before they generate
 * against it. Nothing here blocks generation; the backend has no such
 * check either.
 */
function DutyStatusList({ startDate, numWeeks }: { startDate: string; numWeeks: number }) {
  const { data: dutyAssignments, isLoading: dutyLoading, isError: dutyError } = useDuty();
  const { data: closures, isLoading: closuresLoading, isError: closuresError } = useClosures();

  const weekStartDates = useMemo(
    () => Array.from({ length: numWeeks }, (_, i) => addDays(startDate, i * 7)),
    [startDate, numWeeks],
  );

  if (dutyLoading || closuresLoading) {
    return <p className="mt-3 text-xs text-ink/50">Checking duty status...</p>;
  }

  if (dutyError || closuresError) {
    return <p className="mt-3 text-xs text-red-700">Could not load duty status.</p>;
  }

  return (
    <div className="mt-3">
      <p className="text-sm font-medium text-ink">Duty status</p>
      <ul className="mt-1 space-y-1">
        {weekStartDates.map((weekStart) => {
          const complete = isDutyWeekComplete(weekStart, dutyAssignments ?? [], closures ?? []);
          return (
            <li key={weekStart} className="flex items-center gap-2">
              <span className="text-sm text-ink/70">{formatWeekLabel(weekStart)}</span>
              <span
                data-testid={`generate-week-duty-status-${weekStart}`}
                className={`rounded px-1.5 py-0.5 text-xs font-medium ${
                  complete ? "bg-green-100 text-green-900" : "bg-amber-100 text-amber-900"
                }`}
              >
                {complete ? "Duty fully staffed" : "Duty not fully staffed"}
              </span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/**
 * Advisory list of all clinic types, enabled and disabled - read-only,
 * purely informational (like DutyStatusList above, it blocks nothing).
 * Unlike duty status this isn't per-week: ClinicType.is_enabled is a
 * single global flag, not tied to a generation week, so there is one
 * list, not one per week. Sourced from the same GET /clinic-types the
 * rota grid itself uses, ordered by clinic_priority to match how Phase 5
 * actually processes them (disabled clinics keep their priority slot in
 * that ordering so the position is a stable reference point, even though
 * Phase 5 skips them). Disabled clinics are shown muted red alongside the
 * enabled (green) ones, rather than in a separate list, so it reads at a
 * glance as "this clinic exists but will not be generated".
 */
function ClinicStatusList() {
  const { data: clinicTypes, isLoading, isError } = useClinicTypes();

  if (isLoading) {
    return <p className="mt-3 text-xs text-ink/50">Checking clinic status...</p>;
  }

  if (isError) {
    return <p className="mt-3 text-xs text-red-700">Could not load clinic status.</p>;
  }

  const allClinics = (clinicTypes ?? []).slice().sort((a, b) => a.clinic_priority - b.clinic_priority);

  return (
    <div className="mt-3">
      <p className="text-sm font-medium text-ink">Clinics</p>
      {allClinics.length === 0 ? (
        <p className="mt-1 text-xs text-ink/50">No clinic types have been configured.</p>
      ) : (
        <ul className="mt-1 flex flex-wrap gap-1">
          {allClinics.map((clinicType) => (
            <li
              key={clinicType.id}
              data-testid={`generate-clinic-status-${clinicType.id}`}
              className={
                clinicType.is_enabled
                  ? "rounded bg-green-100 px-1.5 py-0.5 text-xs font-medium text-green-900"
                  : "rounded bg-red-50 px-1.5 py-0.5 text-xs font-medium text-red-400"
              }
            >
              {clinicType.name}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function GenerateRotaForm() {
  const navigate = useNavigate();
  const generateRota = useGenerateRota();
  const upcomingMondays = useMemo(() => getUpcomingMondays(UPCOMING_WEEK_COUNT), []);
  const [startDate, setStartDate] = useState(upcomingMondays[0]);
  const [numWeeks, setNumWeeks] = useState<1 | 2 | 4>(1);

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    // template_start_week is intentionally not a form field - always 1
    // for now (product decision: hide it until there's a real need to
    // start generation mid-template).
    const payload: GenerateRotaIn = {
      start_date: startDate,
      num_weeks: numWeeks,
      template_start_week: 1,
    };

    generateRota.mutate(payload, {
      onSuccess: (data) => {
        navigate(`/rota/${data.rota_id}`);
      },
    });
  }

  return (
    <form onSubmit={handleSubmit} className="rounded border border-border bg-surface p-4">
      <h2 className="text-base font-semibold">Generate a rota</h2>

      <div className="mt-3">
        <label className="block text-sm font-medium text-ink" htmlFor="start-date">
          Week starting
        </label>
        <select
          id="start-date"
          value={startDate}
          onChange={(event) => setStartDate(event.target.value)}
          className="mt-1 rounded border border-border px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-accent"
        >
          {upcomingMondays.map((monday) => (
            <option key={monday} value={monday}>
              {formatWeekLabel(monday)}
            </option>
          ))}
        </select>
      </div>

      <div className="mt-3">
        <label className="block text-sm font-medium text-ink" htmlFor="num-weeks">
          Number of weeks
        </label>
        <select
          id="num-weeks"
          value={numWeeks}
          onChange={(event) => setNumWeeks(Number(event.target.value) as 1 | 2 | 4)}
          className="mt-1 rounded border border-border px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-accent"
        >
          <option value={1}>1</option>
          <option value={2}>2</option>
          <option value={4}>4</option>
        </select>
      </div>

      <DutyStatusList startDate={startDate} numWeeks={numWeeks} />
      <ClinicStatusList />

      <button
        type="submit"
        disabled={generateRota.isPending}
        className="mt-4 rounded bg-accent px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
      >
        {generateRota.isPending ? "Generating..." : "Generate rota"}
      </button>

      {generateRota.isError ? <GenerateErrorMessage error={generateRota.error} /> : null}
    </form>
  );
}

type HistoryTab = "committed" | "archived";

export function RotaPage() {
  const { data: rotas, isLoading, isError } = useRotaList();
  const [historyTab, setHistoryTab] = useState<HistoryTab>("committed");

  if (isLoading) {
    return <p className="text-sm text-ink/70">Loading rotas...</p>;
  }

  if (isError || !rotas) {
    return <p className="text-sm text-red-700">Could not load rotas.</p>;
  }

  // At most one draft exists by design (the API 409s a second generate
  // while one is active) - .find() rather than .filter() reflects that.
  const activeDraft = rotas.find((r) => r.status === "draft");
  const committed = rotas.filter((r) => r.status === "committed");

  // Purely client-side split on archived_at - the API returns committed
  // and archived rotas in the same list (architecture decision: no query
  // param, no server-side filtering - see the archive plan's Decision 8).
  const unarchived = committed.filter((r) => r.archived_at === null);
  const archived = committed.filter((r) => r.archived_at !== null);
  const visibleHistory = historyTab === "committed" ? unarchived : archived;
  const emptyHistoryMessage = historyTab === "committed" ? "No committed rotas yet." : "No archived rotas.";

  return (
    <div className="max-w-2xl">
      <h1 className="text-lg font-semibold">Rota</h1>

      {activeDraft ? (
        <div className="mt-4 rounded border border-accent/40 bg-accent/5 p-4">
          <p className="text-sm font-medium text-ink">
            Draft in progress - started {formatDate(activeDraft.start_date)}, {activeDraft.num_weeks} week
            {activeDraft.num_weeks > 1 ? "s" : ""}
          </p>
          <Link to={`/rota/${activeDraft.rota_id}`} className="mt-2 inline-block text-sm font-medium text-accent underline">
            Open draft
          </Link>
        </div>
      ) : (
        <div className="mt-4">
          <GenerateRotaForm />
        </div>
      )}

      <div className="mt-6">
        <h2 className="text-base font-semibold">Committed history</h2>

        <div className="mt-2 flex gap-2">
          <button
            type="button"
            onClick={() => setHistoryTab("committed")}
            aria-pressed={historyTab === "committed"}
            className={`rounded border px-3 py-1 text-sm font-medium ${
              historyTab === "committed"
                ? "border-accent bg-accent/10 text-accent"
                : "border-border text-ink/70 hover:text-ink"
            }`}
          >
            Committed
          </button>
          <button
            type="button"
            onClick={() => setHistoryTab("archived")}
            aria-pressed={historyTab === "archived"}
            className={`rounded border px-3 py-1 text-sm font-medium ${
              historyTab === "archived"
                ? "border-accent bg-accent/10 text-accent"
                : "border-border text-ink/70 hover:text-ink"
            }`}
          >
            Archived
          </button>
        </div>

        {visibleHistory.length === 0 ? (
          <p className="mt-2 text-sm text-ink/70">{emptyHistoryMessage}</p>
        ) : (
          <ul className="mt-2 divide-y divide-border rounded border border-border">
            {visibleHistory.map((rota) => (
              <li key={rota.rota_id} className="px-3 py-2 text-sm">
                <Link to={`/rota/${rota.rota_id}`} className="text-accent underline">
                  {formatDate(rota.start_date)} - {rota.num_weeks} week{rota.num_weeks > 1 ? "s" : ""}
                </Link>
                <span className="ml-2 text-ink/50">
                  committed {formatDateTime(rota.committed_at ?? rota.created_at)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}