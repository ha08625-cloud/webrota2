import { useMemo, useState } from "react";

import {
  fetchReceptionRotaByDate,
  useAssignReceptionRota,
  useCreateReceptionRotaSession,
  useDeleteReceptionRota,
  useDeleteReceptionRotaSession,
  useGenerateReceptionRota,
  usePatchReceptionRotaSession,
  useReceptionRotaByDate,
  useReceptionStaff,
} from "@/api/reception";
import type { ApiError, ReceptionRota, ReceptionRotaSession, ReceptionStaff } from "@/api/types";
import { useWriteGate } from "@/auth/AuthContext";
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

/** "Mon 3 Sep" - the day tabs read as dates, not as ISO identifiers. */
function tabLabel(date: string): string {
  return parseLocalDate(date).toLocaleDateString("en-GB", {
    weekday: "short",
    day: "numeric",
    month: "short",
  });
}

/**
 * The day rota: a week-commencing dropdown plus a Monday-Friday tab strip,
 * each tab independently one of two states decided by GET /reception/rota
 * ?date= - a 404 offers "Generate from template", a 200 renders the
 * ReceptionGrid/ReceptionCellPopover pair built for the master template
 * (Task 7) unchanged, against that date's sessions, with a coverage panel
 * beside the page header (reception rota plan, Task 8).
 *
 * The backend has no week concept at all - each date is still its own
 * header, generated/regenerated/deleted independently (409 if it already
 * exists). "Generate week" is a client-side loop over the five existing
 * per-day endpoints: it first reads all five dates, and any day that
 * already has a rota is DELETED and rebuilt rather than skipped, so the
 * button always leaves the whole week freshly copied from the template.
 * Because that destroys edits, a confirm is raised first whenever at
 * least one day already exists. Editing and single-day Regenerate both
 * stay per-day, on the active tab.
 *
 * Generating (per-day or per-week) always chains the assignment step (front
 * desk, then the phones top-up) onto the fresh day, so "generate" produces a
 * manned day in one gesture.
 */
export function ReceptionDayPage() {
  const writeGate = useWriteGate();
  const weekOptions = useMemo(() => getSurroundingMondays(PAST_WEEKS, FUTURE_WEEKS), []);
  const [weekStart, setWeekStart] = useState(weekOptions[PAST_WEEKS]);
  const weekDates = useMemo(() => WEEKDAY_OFFSETS.map((n) => addDays(weekStart, n)), [weekStart]);
  const [activeDate, setActiveDate] = useState(weekDates[0]);

  const { data: staff } = useReceptionStaff(true);
  // Same query key the active tab uses, so this shares its cache entry
  // rather than issuing a second request - the panel just needs the
  // issues from it, and it lives beside the page header now, not beside
  // the grid.
  const { data: activeRota } = useReceptionRotaByDate(activeDate);
  const generateRota = useGenerateReceptionRota();
  const deleteRota = useDeleteReceptionRota();
  const assignRota = useAssignReceptionRota();
  const [generatingWeek, setGeneratingWeek] = useState(false);
  const [weekError, setWeekError] = useState<string | null>(null);

  function handleWeekChange(newWeekStart: string) {
    setWeekStart(newWeekStart);
    setActiveDate(newWeekStart);
  }

  /**
   * Scrap-and-regenerate for the whole week. Every weekday is read first
   * so the confirm can be raised once, up front, rather than mid-loop:
   * blowing away a week of hand-edits is worth a single explicit yes, and
   * a per-day prompt in the middle of a five-day loop would be worse.
   *
   * A day that already exists is deleted before being generated again -
   * POST /reception/rota 409s on an existing date, which is what made the
   * old skip-on-409 version of this button appear to do nothing once a
   * week had been generated.
   */
  async function handleGenerateWeek() {
    setWeekError(null);
    setGeneratingWeek(true);

    let existing: (ReceptionRota | null)[];
    try {
      existing = await Promise.all(weekDates.map((date) => fetchReceptionRotaByDate(date)));
    } catch (err) {
      setGeneratingWeek(false);
      setWeekError(apiErrorMessage(err as ApiError, "Could not check which days already have a rota."));
      return;
    }

    if (existing.some((rota) => rota !== null)) {
      const confirmed = window.confirm(
        "This will scrap the existing rota for this week and regenerate it from scratch, " +
          "deleting every edit made to those days. Proceed?",
      );
      if (!confirmed) {
        setGeneratingWeek(false);
        return;
      }
    }

    const failures: string[] = [];
    for (const [index, date] of weekDates.entries()) {
      try {
        const current = existing[index];
        if (current) {
          await deleteRota.mutateAsync({ rotaId: current.rota_id, date });
        }
        const generated = await generateRota.mutateAsync(date);
        // Assignment is chained onto every day now, not only the newly
        // created ones: after this button runs, every day in the week is a
        // fresh copy of the template, so every day needs its desk manned -
        // the old "leave existing days alone" carve-out no longer applies to
        // a button that rebuilds them.
        await assignRota.mutateAsync({ rotaId: generated.rota_id, date });
      } catch (err) {
        failures.push(`${date}: ${apiErrorMessage(err as ApiError, "failed")}`);
      }
    }
    setGeneratingWeek(false);
    if (failures.length > 0) {
      setWeekError(`Could not generate every day: ${failures.join("; ")}`);
    }
  }

  return (
    <div>
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-lg font-semibold">Day Rota</h1>

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
              {...writeGate}
            >
              {generatingWeek ? "Generating..." : "Generate week from template"}
            </button>
          </div>

          {weekError ? <p className="mt-3 rounded bg-red-50 p-2 text-sm text-red-700">{weekError}</p> : null}
        </div>

        {activeRota ? <ReceptionCoveragePanel issues={activeRota.issues} /> : null}
      </div>

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
              className={`-mb-px rounded-t-md border-b-2 px-4 py-2 text-sm font-medium transition-colors ${
                isActive
                  ? "border-accent text-accent"
                  : "border-transparent text-ink/60 hover:bg-ink/[0.03] hover:text-ink"
              }`}
            >
              {tabLabel(date)}
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
  const writeGate = useWriteGate();
  const [actionError, setActionError] = useState<string | null>(null);
  const [savingRange, setSavingRange] = useState(false);

  const { data: rota, isLoading, isError, error } = useReceptionRotaByDate(date);
  const generateRota = useGenerateReceptionRota();
  const deleteRota = useDeleteReceptionRota();
  const assignRota = useAssignReceptionRota();
  const createSession = useCreateReceptionRotaSession();
  const updateSession = usePatchReceptionRotaSession();
  const deleteSession = useDeleteReceptionRotaSession();

  const notFound = isError && error.status === 404;
  const saving =
    savingRange || generateRota.isPending || deleteRota.isPending || assignRota.isPending;

  /**
   * Generating a day means "copy the template *and* assign it" - two
   * endpoints, always chained, in the same order handleGenerateWeek uses.
   * They stay separate server-side (POST "" keeps its 409 semantics, and
   * assignment stays independently re-runnable), but there is no longer a
   * button that runs only the first half.
   *
   * The two failures are reported separately: a failed assignment still
   * leaves a generated day on screen, so saying "could not generate" there
   * would be wrong.
   */
  async function generateAndAssign(generateFallback: string) {
    let generated;
    try {
      generated = await generateRota.mutateAsync(date);
    } catch (err) {
      setActionError(apiErrorMessage(err as ApiError, generateFallback));
      return;
    }
    try {
      await assignRota.mutateAsync({ rotaId: generated.rota_id, date });
    } catch (err) {
      setActionError(
        apiErrorMessage(err as ApiError, "The day was generated, but it could not be assigned."),
      );
    }
  }

  function handleGenerate() {
    setActionError(null);
    void generateAndAssign("Could not generate this day.");
  }

  async function handleRegenerate() {
    if (!rota) return;
    const confirmed = window.confirm(
      "Regenerating will delete every edit made to this day and copy the master template fresh. Continue?",
    );
    if (!confirmed) return;

    setActionError(null);
    try {
      await deleteRota.mutateAsync({ rotaId: rota.rota_id, date });
    } catch (err) {
      setActionError(apiErrorMessage(err as ApiError, "Could not regenerate this day."));
      return;
    }
    await generateAndAssign("Could not regenerate this day.");
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
            disabled={saving}
            className="mt-2 rounded bg-accent px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
            {...writeGate}
          >
            Generate from template
          </button>
        </div>
      ) : null}

      {isError && !notFound ? <p className="text-sm text-red-700">Could not load this day's rota.</p> : null}

      {rota ? (
        <div>
          <div className="flex items-center justify-end">
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => void handleRegenerate()}
                disabled={saving}
                className="rounded border border-border px-3 py-1 text-sm text-ink/80 hover:bg-accent/5 disabled:opacity-50"
                {...writeGate}
              >
                Regenerate
              </button>
            </div>
          </div>

          <div className="mt-3">
            <ReceptionGrid
              key={date}
              staff={staff}
              sessions={rota.sessions}
              issues={rota.issues}
              staffOnLeave={rota.staff_on_leave}
              onSave={handleSave}
              onDelete={handleDelete}
              saving={saving}
            />
          </div>
        </div>
      ) : null}
    </div>
  );
}
