import { useState } from "react";

import {
  useCreateReceptionRotaSession,
  useDeleteReceptionRota,
  useDeleteReceptionRotaSession,
  useGenerateReceptionRota,
  usePatchReceptionRotaSession,
  useReceptionRotaByDate,
  useReceptionStaff,
} from "@/api/reception";
import type { ApiError, ReceptionRotaSession } from "@/api/types";
import { ReceptionCoveragePanel } from "@/components/ReceptionCoveragePanel";
import { ReceptionGrid, type ReceptionSavePayload } from "@/components/ReceptionGrid";
import { parseLocalDate } from "@/lib/date";

/**
 * True for a Saturday or Sunday. Mirrors the server's weekday-only rule
 * on POST /reception/rota (reception rota plan, Decision 6) client-side,
 * same reasoning as ExtraSessionsPage's isWeekend - the server's own 422
 * is never the first line of defence.
 */
function isWeekend(dateString: string): boolean {
  const day = parseLocalDate(dateString).getDay();
  return day === 0 || day === 6;
}

function apiErrorMessage(err: ApiError, fallback: string): string {
  return typeof err.detail === "string" ? err.detail : fallback;
}

/**
 * The day rota: a weekday date picker plus one of two states decided by
 * GET /reception/rota?date= - a 404 offers "Generate from template", a
 * 200 renders the ReceptionGrid/ReceptionCellPopover pair built for the
 * master template (Task 7) unchanged, against this date's sessions, with
 * a coverage panel alongside (reception rota plan, Task 8).
 *
 * Regenerating is delete-then-generate behind a confirm (Decision 6), not
 * a force flag - the confirm is exactly where the user is told every edit
 * to this day will be lost, and the server itself refuses to overwrite a
 * day silently (409 on POST over an existing header).
 */
export function ReceptionDayPage() {
  const [date, setDate] = useState("");
  const [actionError, setActionError] = useState<string | null>(null);

  const dateIsWeekend = date !== "" && isWeekend(date);
  const queryDate = date !== "" && !dateIsWeekend ? date : undefined;

  const { data: staff } = useReceptionStaff(true);
  const { data: rota, isLoading, isError, error } = useReceptionRotaByDate(queryDate);
  const generateRota = useGenerateReceptionRota();
  const deleteRota = useDeleteReceptionRota();
  const createSession = useCreateReceptionRotaSession();
  const updateSession = usePatchReceptionRotaSession();
  const deleteSession = useDeleteReceptionRotaSession();

  const notFound = isError && error.status === 404;
  const saving =
    generateRota.isPending ||
    deleteRota.isPending ||
    createSession.isPending ||
    updateSession.isPending ||
    deleteSession.isPending;

  function handleGenerate() {
    if (queryDate === undefined) return;
    setActionError(null);
    generateRota.mutate(queryDate, {
      onError: (err) => setActionError(apiErrorMessage(err, "Could not generate this day.")),
    });
  }

  function handleRegenerate() {
    if (!rota || queryDate === undefined) return;
    const confirmed = window.confirm(
      "Regenerating will delete every edit made to this day and copy the master template fresh. Continue?",
    );
    if (!confirmed) return;

    setActionError(null);
    deleteRota.mutate(
      { rotaId: rota.rota_id, date: queryDate },
      {
        onSuccess: () => {
          generateRota.mutate(queryDate, {
            onError: (err) => setActionError(apiErrorMessage(err, "Could not regenerate this day.")),
          });
        },
        onError: (err) => setActionError(apiErrorMessage(err, "Could not regenerate this day.")),
      },
    );
  }

  function handleSave({ staffId, hour, session, role, note }: ReceptionSavePayload<ReceptionRotaSession>) {
    if (!rota || queryDate === undefined) return;
    setActionError(null);
    const onError = (err: ApiError) => setActionError(apiErrorMessage(err, "Could not save this slot."));
    if (session) {
      updateSession.mutate(
        { rotaId: rota.rota_id, date: queryDate, sessionId: session.session_id, role, note },
        { onError },
      );
    } else {
      createSession.mutate({ rotaId: rota.rota_id, date: queryDate, staffId, hour, role, note }, { onError });
    }
  }

  function handleDelete(session: ReceptionRotaSession) {
    if (!rota || queryDate === undefined) return;
    setActionError(null);
    deleteSession.mutate(
      { rotaId: rota.rota_id, date: queryDate, sessionId: session.session_id },
      { onError: (err: ApiError) => setActionError(apiErrorMessage(err, "Could not remove this slot.")) },
    );
  }

  return (
    <div>
      <h1 className="text-lg font-semibold">Day Rota</h1>
      <p className="mt-2 max-w-2xl text-sm text-ink/70">
        Pick a weekday to generate that day's rota from the master template, or edit an existing one.
      </p>

      <div className="mt-4">
        <label className="block text-xs font-medium text-ink/70" htmlFor="reception-day-date">
          Date
        </label>
        <input
          id="reception-day-date"
          type="date"
          value={date}
          onChange={(e) => setDate(e.target.value)}
          className="mt-1 rounded border border-border p-1 text-sm"
        />
        {dateIsWeekend ? (
          <p className="mt-1 text-xs text-red-700">
            {date} is a weekend; the day rota only runs Monday to Friday.
          </p>
        ) : null}
      </div>

      {actionError ? <p className="mt-3 rounded bg-red-50 p-2 text-sm text-red-700">{actionError}</p> : null}

      {queryDate === undefined ? null : (
        <div className="mt-4">
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

          {rota && staff ? (
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
      )}
    </div>
  );
}
