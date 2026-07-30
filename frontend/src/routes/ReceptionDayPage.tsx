import { useMemo, useState } from "react";

import {
  useCreateReceptionRotaSession,
  useDeleteReceptionRota,
  useDeleteReceptionRotaSession,
  useGenerateReceptionRota,
  usePatchReceptionRotaSession,
  useReceptionRotaByDate,
  useReceptionStaff,
} from "@/api/reception";
import type { ApiError, ReceptionRotaSession, ReceptionStaff } from "@/api/types";
import { ReceptionCoveragePanel } from "@/components/ReceptionCoveragePanel";
import { ReceptionGrid, type ReceptionSavePayload } from "@/components/ReceptionGrid";
import { addDays, formatWeekLabel, getSurroundingMondays, parseLocalDate } from "@/lib/date";
import { formatHour } from "@/lib/receptionHours";

/** Weeks reachable behind/ahead of the current week in the "Week commencing" dropdown. */
const PAST_WEEKS = 4;
const FUTURE_WEEKS = 16;

/** Offsets from a week's Monday for the five weekdays the day rota covers. */
const WEEKDAY_OFFSETS = [0, 1, 2, 3, 4];

function apiErrorMessage(err: ApiError, fallback: string): string {
  return typeof err.detail === "string" ? err.detail : fallback;
}

function weekdayLabel(date: string): string {
  return parseLocalDate(date).toLocaleDateString("en-GB", { weekday: "long" });
}

/**
 * The day rota: a week-commencing dropdown plus a Monday-Friday tab strip,
 * each tab independently one of two states decided by GET /reception/rota
 * ?date= - a 404 offers "Generate from template", a 200 renders the
 * ReceptionGrid/ReceptionCellPopover pair built for the master template
 * (Task 7) unchanged, against that date's sessions, with a coverage panel
 * alongside (reception rota plan, Task 8).
 *
 * The backend has no week concept at all - each date is still its own
 * header, generated/regenerated/deleted independently (409 if it already
 * exists). "Generate week" is a client-side loop over the five existing
 * per-day POSTs, skipping (not erroring on) any day that already has a
 * rota; regenerating and editing both stay per-day, on the active tab.
 */
export function ReceptionDayPage() {
  const weekOptions = useMemo(() => getSurroundingMondays(PAST_WEEKS, FUTURE_WEEKS), []);
  const [weekStart, setWeekStart] = useState(weekOptions[PAST_WEEKS]);
  const weekDates = useMemo(() => WEEKDAY_OFFSETS.map((n) => addDays(weekStart, n)), [weekStart]);
  const [activeDate, setActiveDate] = useState(weekDates[0]);

  const { data: staff } = useReceptionStaff(true);
  const generateRota = useGenerateReceptionRota();
  const [generatingWeek, setGeneratingWeek] = useState(false);
  const [weekError, setWeekError] = useState<string | null>(null);

  function handleWeekChange(newWeekStart: string) {
    setWeekStart(newWeekStart);
    setActiveDate(newWeekStart);
  }

  async function handleGenerateWeek() {
    setWeekError(null);
    setGeneratingWeek(true);
    const failures: string[] = [];
    for (const date of weekDates) {
      try {
        await generateRota.mutateAsync(date);
      } catch (err) {
        const apiErr = err as ApiError;
        // A 409 means this day already has a rota - expected, not a failure.
        if (apiErr.status !== 409) {
          failures.push(`${date}: ${apiErrorMessage(apiErr, "failed")}`);
        }
      }
    }
    setGeneratingWeek(false);
    if (failures.length > 0) {
      setWeekError(`Could not generate every day: ${failures.join("; ")}`);
    }
  }

  return (
    <div>
      <h1 className="text-lg font-semibold">Day Rota</h1>
      <p className="mt-2 max-w-2xl text-sm text-ink/70">
        Pick a week to generate Monday to Friday from the master template, or edit an existing week.
      </p>

      <div className="mt-4 flex items-end gap-3">
        <div>
          <label className="block text-xs font-medium text-ink/70" htmlFor="reception-week-start">
            Week commencing
          </label>
          <select
            id="reception-week-start"
            value={weekStart}
            onChange={(e) => handleWeekChange(e.target.value)}
            className="mt-1 rounded border border-border p-1 text-sm"
          >
            {weekOptions.map((monday) => (
              <option key={monday} value={monday}>
                {formatWeekLabel(monday)}
              </option>
            ))}
          </select>
        </div>
        <button
          type="button"
          onClick={handleGenerateWeek}
          disabled={generatingWeek}
          className="rounded bg-accent px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
        >
          {generatingWeek ? "Generating..." : "Generate week from template"}
        </button>
      </div>

      {weekError ? <p className="mt-3 rounded bg-red-50 p-2 text-sm text-red-700">{weekError}</p> : null}

      <div className="mt-4 flex gap-1 border-b border-border" role="tablist" aria-label="Day">
        {weekDates.map((date) => {
          const isActive = date === activeDate;
          return (
            <button
              key={date}
              type="button"
              role="tab"
              aria-selected={isActive}
              onClick={() => setActiveDate(date)}
              className={`px-4 py-2 text-sm font-medium ${
                isActive ? "border-b-2 border-accent text-accent" : "text-ink/60 hover:text-ink"
              }`}
            >
              {weekdayLabel(date)} {date}
            </button>
          );
        })}
      </div>

      <div className="mt-4">{staff ? <ReceptionDayTab date={activeDate} staff={staff} /> : null}</div>
    </div>
  );
}

interface ReceptionDayTabProps {
  date: string;
  staff: ReceptionStaff[];
}

/**
 * One weekday's generate/regenerate/edit lifecycle - the body the single-day
 * ReceptionDayPage used to render directly, now parameterised by `date` and
 * mounted once per active tab.
 */
function ReceptionDayTab({ date, staff }: ReceptionDayTabProps) {
  const [actionError, setActionError] = useState<string | null>(null);
  const [savingRange, setSavingRange] = useState(false);

  const { data: rota, isLoading, isError, error } = useReceptionRotaByDate(date);
  const generateRota = useGenerateReceptionRota();
  const deleteRota = useDeleteReceptionRota();
  const createSession = useCreateReceptionRotaSession();
  const updateSession = usePatchReceptionRotaSession();
  const deleteSession = useDeleteReceptionRotaSession();

  const notFound = isError && error.status === 404;
  const saving = savingRange || generateRota.isPending || deleteRota.isPending;

  function handleGenerate() {
    setActionError(null);
    generateRota.mutate(date, {
      onError: (err) => setActionError(apiErrorMessage(err, "Could not generate this day.")),
    });
  }

  function handleRegenerate() {
    if (!rota) return;
    const confirmed = window.confirm(
      "Regenerating will delete every edit made to this day and copy the master template fresh. Continue?",
    );
    if (!confirmed) return;

    setActionError(null);
    deleteRota.mutate(
      { rotaId: rota.rota_id, date },
      {
        onSuccess: () => {
          generateRota.mutate(date, {
            onError: (err) => setActionError(apiErrorMessage(err, "Could not regenerate this day.")),
          });
        },
        onError: (err) => setActionError(apiErrorMessage(err, "Could not regenerate this day.")),
      },
    );
  }

  async function handleSave(payloads: ReceptionSavePayload<ReceptionRotaSession>[]): Promise<boolean> {
    if (!rota) return false;
    setActionError(null);
    setSavingRange(true);
    const failures: string[] = [];
    for (const { staffId, hour, session, role, note } of payloads) {
      try {
        if (session) {
          await updateSession.mutateAsync({ rotaId: rota.rota_id, date, sessionId: session.session_id, role, note });
        } else {
          await createSession.mutateAsync({ rotaId: rota.rota_id, date, staffId, hour, role, note });
        }
      } catch (err) {
        failures.push(`${formatHour(hour)}: ${apiErrorMessage(err as ApiError, "failed")}`);
      }
    }
    setSavingRange(false);
    if (failures.length > 0) setActionError(`Could not save every hour: ${failures.join("; ")}`);
    return failures.length === 0;
  }

  async function handleDelete(sessions: ReceptionRotaSession[]): Promise<boolean> {
    if (!rota) return false;
    setActionError(null);
    setSavingRange(true);
    const failures: string[] = [];
    for (const session of sessions) {
      try {
        await deleteSession.mutateAsync({ rotaId: rota.rota_id, date, sessionId: session.session_id });
      } catch (err) {
        failures.push(`${formatHour(session.hour)}: ${apiErrorMessage(err as ApiError, "failed")}`);
      }
    }
    setSavingRange(false);
    if (failures.length > 0) setActionError(`Could not remove every hour: ${failures.join("; ")}`);
    return failures.length === 0;
  }

  return (
    <div>
      {actionError ? <p className="mb-3 rounded bg-red-50 p-2 text-sm text-red-700">{actionError}</p> : null}

      {isLoading ? <p className="text-sm text-ink/70">Loading...</p> : null}

      {notFound ? (
        <div>
          <p className="text-sm text-ink/70">No rota has been generated for this date yet.</p>
          <button
            type="button"
            onClick={handleGenerate}
            disabled={generateRota.isPending}
            className="mt-2 rounded bg-accent px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
          >
            Generate from template
          </button>
        </div>
      ) : null}

      {isError && !notFound ? <p className="text-sm text-red-700">Could not load this day's rota.</p> : null}

      {rota ? (
        <div>
          <div className="flex items-center justify-between">
            <p className="text-sm text-ink/70">
              Generated {rota.sessions.length} session{rota.sessions.length === 1 ? "" : "s"}.
            </p>
            <button
              type="button"
              onClick={handleRegenerate}
              disabled={saving}
              className="rounded border border-border px-3 py-1 text-sm text-ink/80 hover:bg-accent/5 disabled:opacity-50"
            >
              Regenerate
            </button>
          </div>

          <div className="mt-3 flex gap-4">
            <ReceptionGrid
              key={date}
              staff={staff}
              sessions={rota.sessions}
              issues={rota.issues}
              onSave={handleSave}
              onDelete={handleDelete}
              saving={saving}
            />
            <ReceptionCoveragePanel issues={rota.issues} />
          </div>
        </div>
      ) : null}
    </div>
  );
}
