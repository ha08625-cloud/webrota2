import { useMemo, useState, type FormEvent } from "react";
import { Link, useNavigate } from "react-router-dom";

import { useGenerateRota, useRotaList } from "@/api/rota";
import type { ApiError, FastApiValidationError, GenerateRotaIn, ValidationIssue } from "@/api/types";
import { formatDate, formatDateTime, formatWeekLabel, getUpcomingMondays } from "@/lib/date";

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

export function RotaPage() {
  const { data: rotas, isLoading, isError } = useRotaList();

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
        {committed.length === 0 ? (
          <p className="mt-2 text-sm text-ink/70">No committed rotas yet.</p>
        ) : (
          <ul className="mt-2 divide-y divide-border rounded border border-border">
            {committed.map((rota) => (
              <li key={rota.rota_id} className="px-3 py-2 text-sm">
                <Link to={`/rota/${rota.rota_id}`} className="text-accent underline">
                  {formatDate(rota.start_date)} - {rota.num_weeks} week{rota.num_weeks > 1 ? "s" : ""}
                </Link>
                <span className="ml-2 text-ink/50">committed {formatDateTime(rota.created_at)}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}