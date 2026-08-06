import { useMemo, useState, type FormEvent } from "react";
import { Link, useNavigate } from "react-router-dom";

import { useActiveStaging, useCreateStaging } from "@/api/staging";
import { useClinicTypes, usePatchClinicType } from "@/api/clinicTypes";
import { useClosures } from "@/api/closures";
import { useDuty } from "@/api/duty";
import { useRotaList } from "@/api/rota";
import type { ClinicType, CreateStagingIn } from "@/api/types";
import { DutyGrid } from "@/components/DutyGrid";
import { GenerateErrorMessage } from "@/components/GenerateErrorMessage";
import { addDays, formatDate, formatDateTime, formatWeekLabel, getUpcomingMondays } from "@/lib/date";
import { isDutyWeekComplete } from "@/lib/dutyWeekComplete";

const UPCOMING_WEEK_COUNT = 12;

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
 * List of all clinic types, enabled and disabled, with an inline enable
 * checkbox - so a clinic wrongly left enabled can be caught and disabled
 * right before generating, without a round trip to the Clinic Types page.
 * Unlike duty status this isn't per-week: ClinicType.is_enabled is a
 * single global flag, not tied to a generation week, so there is one
 * list, not one per week. Sourced from the same GET /clinic-types the
 * rota grid itself uses, ordered by clinic_priority to match how Phase 5
 * actually processes them (disabled clinics keep their priority slot in
 * that ordering so the position is a stable reference point, even though
 * Phase 5 skips them). Disabled clinics are shown muted red alongside the
 * enabled (green) ones, rather than in a separate list, so it reads at a
 * glance as "this clinic exists but will not be generated". The checkbox
 * reuses usePatchClinicType (the same PATCH /clinic-types/{id} mutation
 * ClinicTypesPage's inline toggle uses) - unlike that page, this list is
 * never reordered, so there's no enabled-id-set race to guard against and
 * every row's checkbox can stay independently enabled/disabled by its own
 * pending state rather than one page-wide lock.
 */
function ClinicStatusList() {
  const { data: clinicTypes, isLoading, isError } = useClinicTypes();
  const patchClinicType = usePatchClinicType();
  const [toggleError, setToggleError] = useState<string | null>(null);

  if (isLoading) {
    return <p className="mt-3 text-xs text-ink/50">Checking clinic status...</p>;
  }

  if (isError) {
    return <p className="mt-3 text-xs text-red-700">Could not load clinic status.</p>;
  }

  const allClinics = (clinicTypes ?? []).slice().sort((a, b) => a.clinic_priority - b.clinic_priority);

  function handleToggleEnabled(clinicType: ClinicType, checked: boolean) {
    setToggleError(null);
    patchClinicType.mutate(
      { id: clinicType.id, payload: { is_enabled: checked } },
      {
        onError: (err) => {
          setToggleError(typeof err.detail === "string" ? err.detail : "Could not update this clinic type.");
        },
      },
    );
  }

  return (
    <div className="mt-3">
      <p className="text-sm font-medium text-ink">Clinics</p>
      {allClinics.length === 0 ? (
        <p className="mt-1 text-xs text-ink/50">No clinic types have been configured.</p>
      ) : (
        <ul className="mt-1 flex flex-wrap gap-2">
          {allClinics.map((clinicType) => (
            <li
              key={clinicType.id}
              data-testid={`generate-clinic-status-${clinicType.id}`}
              className={
                clinicType.is_enabled
                  ? "flex items-center gap-1 rounded bg-green-100 px-1.5 py-0.5 text-xs font-medium text-green-900"
                  : "flex items-center gap-1 rounded bg-red-50 px-1.5 py-0.5 text-xs font-medium text-red-400"
              }
            >
              <input
                type="checkbox"
                aria-label={`Enabled for ${clinicType.name}`}
                checked={clinicType.is_enabled}
                disabled={patchClinicType.isPending}
                onChange={(e) => handleToggleEnabled(clinicType, e.target.checked)}
              />
              {clinicType.name}
            </li>
          ))}
        </ul>
      )}
      {toggleError ? <p className="mt-1 text-xs text-red-700">{toggleError}</p> : null}
    </div>
  );
}

/**
 * The generate form no longer generates directly (staging plan, Task 6):
 * submitting creates a staging - a copy of the active template's rows for
 * the chosen range - and navigates to /staging, where the one-off edits
 * happen before the Phase 0-12 pipeline actually runs (StagingPage's
 * "Complete and generate" action).
 */
interface StartStagingFormProps {
  upcomingMondays: string[];
  startDate: string;
  setStartDate: (date: string) => void;
  numWeeks: 1 | 2 | 4;
  setNumWeeks: (weeks: 1 | 2 | 4) => void;
}

function StartStagingForm({
  upcomingMondays,
  startDate,
  setStartDate,
  numWeeks,
  setNumWeeks,
}: StartStagingFormProps) {
  const navigate = useNavigate();
  const createStaging = useCreateStaging();
  const [templateStartWeek, setTemplateStartWeek] = useState<1 | 2 | 3 | 4>(1);

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    // Staging create applies template_start_week once at copy time, to
    // pick which template weeks get copied, then discards it (staging
    // plan, Design Decision 4) - the persisted RotaConfig always stores
    // template_start_week=1.
    const payload: CreateStagingIn = {
      start_date: startDate,
      num_weeks: numWeeks,
      template_start_week: templateStartWeek,
    };

    createStaging.mutate(payload, {
      onSuccess: () => navigate("/clinical/staging"),
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

      <div className="mt-3">
        <label className="block text-sm font-medium text-ink" htmlFor="template-start-week">
          Template starting week
        </label>
        <select
          id="template-start-week"
          value={templateStartWeek}
          onChange={(event) => setTemplateStartWeek(Number(event.target.value) as 1 | 2 | 3 | 4)}
          className="mt-1 rounded border border-border px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-accent"
        >
          <option value={1}>Week 1</option>
          <option value={2}>Week 2</option>
          <option value={3}>Week 3</option>
          <option value={4}>Week 4</option>
        </select>
      </div>

      <DutyStatusList startDate={startDate} numWeeks={numWeeks} />
      <ClinicStatusList />

      <button
        type="submit"
        disabled={createStaging.isPending}
        className="mt-4 rounded bg-accent px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
      >
        {createStaging.isPending ? "Starting..." : "Start staging"}
      </button>

      {createStaging.isError ? <GenerateErrorMessage error={createStaging.error} /> : null}
    </form>
  );
}

type HistoryTab = "committed" | "archived";

export function RotaPage() {
  const { data: rotas, isLoading, isError } = useRotaList();
  const { data: activeStaging, isLoading: stagingLoading } = useActiveStaging();
  const [historyTab, setHistoryTab] = useState<HistoryTab>("committed");

  // Lifted out of StartStagingForm so the duty preview sidebar can render
  // the same start week / week count the form is currently set to, without
  // needing to click into the Duty page to check or fix staffing.
  const upcomingMondays = useMemo(() => getUpcomingMondays(UPCOMING_WEEK_COUNT), []);
  const [startDate, setStartDate] = useState(upcomingMondays[0]);
  const [numWeeks, setNumWeeks] = useState<1 | 2 | 4>(1);

  if (isLoading || stagingLoading) {
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

  // No draft/staging in progress means the start-week form (and therefore
  // a "selected week") is what's on screen - that's the only time the duty
  // preview sidebar has a week to show.
  const showDutyPreview = !activeDraft && !activeStaging;

  return (
    <div className="flex flex-wrap items-start gap-6">
      <div className="max-w-2xl flex-1">
        <h1 className="text-lg font-semibold">Rota</h1>

        {activeDraft ? (
          <div className="mt-4 rounded border border-accent/40 bg-accent/5 p-4">
            <p className="text-sm font-medium text-ink">
              Draft in progress - started {formatDate(activeDraft.start_date)}, {activeDraft.num_weeks} week
              {activeDraft.num_weeks > 1 ? "s" : ""}
            </p>
            <Link to={`/clinical/rota/${activeDraft.rota_id}`} className="mt-2 inline-block text-sm font-medium text-accent underline">
              Open draft
            </Link>
          </div>
        ) : activeStaging ? (
          <div className="mt-4 rounded border border-accent/40 bg-accent/5 p-4">
            <p className="text-sm font-medium text-ink">
              Staging in progress - started {formatDate(activeStaging.start_date)}, {activeStaging.num_weeks} week
              {activeStaging.num_weeks > 1 ? "s" : ""}
            </p>
            <Link to="/clinical/staging" className="mt-2 inline-block text-sm font-medium text-accent underline">
              Resume staging
            </Link>
          </div>
        ) : (
          <div className="mt-4">
            <StartStagingForm
              upcomingMondays={upcomingMondays}
              startDate={startDate}
              setStartDate={setStartDate}
              numWeeks={numWeeks}
              setNumWeeks={setNumWeeks}
            />
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
                  <Link to={`/clinical/rota/${rota.rota_id}`} className="text-accent underline">
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

      {showDutyPreview ? (
        <div className="mt-4 min-w-0 flex-1 rounded border border-border bg-surface p-4" data-testid="rota-duty-preview">
          <h2 className="text-base font-semibold">
            Duty for {formatWeekLabel(startDate)}
            {numWeeks > 1 ? ` - ${numWeeks} weeks` : ""}
          </h2>
          <p className="mt-1 text-xs text-ink/50">
            Adjust duty for the selected week(s) here without leaving this page.
          </p>
          <div className="mt-3 overflow-x-auto">
            <DutyGrid startWeekDate={startDate} weeks={numWeeks} />
          </div>
        </div>
      ) : null}
    </div>
  );
}