import { useState } from "react";

import {
  useCreateReceptionMasterSession,
  useDeleteReceptionMasterSession,
  useReceptionMasterSessions,
  useReceptionStaff,
  useUpdateReceptionMasterSession,
} from "@/api/reception";
import type { ApiError, Day, ReceptionMasterSession } from "@/api/types";
import { ReceptionGrid, type ReceptionSavePayload } from "@/components/ReceptionGrid";
import { formatHour } from "@/lib/receptionHours";

const DAYS: Day[] = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday"];

function apiErrorMessage(err: ApiError, fallback: string): string {
  return typeof err.detail === "string" ? err.detail : fallback;
}

/**
 * The weekday master template - one day at a time, not a five-day-at-once
 * view (5 x 10 x N cells would be unreadable; a day tab is one click, see
 * reception rota plan Task 7). ReceptionGrid/ReceptionCellPopover are the
 * same components Task 8's day rota page reuses unchanged; this page's
 * job is just to own the master-session queries/mutations and filter the
 * flat template list down to the selected day before handing it to the
 * grid.
 */
export function ReceptionMasterPage() {
  // include_inactive so a leaver's still-present template rows still get
  // a row to render on (flagged), rather than looking like an orphaned
  // slot - same reasoning as MasterRotaGrid's useDoctors(false).
  const { data: staff, isLoading: staffLoading, isError: staffError } = useReceptionStaff(true);
  const { data: sessions, isLoading: sessionsLoading, isError: sessionsError } = useReceptionMasterSessions();
  const createSession = useCreateReceptionMasterSession();
  const updateSession = useUpdateReceptionMasterSession();
  const deleteSession = useDeleteReceptionMasterSession();
  const [activeDay, setActiveDay] = useState<Day>("Monday");
  const [error, setError] = useState<string | null>(null);
  const [savingRange, setSavingRange] = useState(false);

  const saving = savingRange;

  async function handleSave(payloads: ReceptionSavePayload<ReceptionMasterSession>[]): Promise<boolean> {
    setError(null);
    setSavingRange(true);
    const failures: string[] = [];
    for (const { staffId, hour, session, role, note } of payloads) {
      try {
        if (session) {
          await updateSession.mutateAsync({ sessionId: session.session_id, role, note });
        } else {
          await createSession.mutateAsync({ staffId, day: activeDay, hour, role, note });
        }
      } catch (err) {
        failures.push(`${formatHour(hour)}: ${apiErrorMessage(err as ApiError, "failed")}`);
      }
    }
    setSavingRange(false);
    if (failures.length > 0) setError(`Could not save every hour: ${failures.join("; ")}`);
    return failures.length === 0;
  }

  async function handleDelete(sessions: ReceptionMasterSession[]): Promise<boolean> {
    setError(null);
    setSavingRange(true);
    const failures: string[] = [];
    for (const session of sessions) {
      try {
        await deleteSession.mutateAsync(session.session_id);
      } catch (err) {
        failures.push(`${formatHour(session.hour)}: ${apiErrorMessage(err as ApiError, "failed")}`);
      }
    }
    setSavingRange(false);
    if (failures.length > 0) setError(`Could not remove every hour: ${failures.join("; ")}`);
    return failures.length === 0;
  }

  return (
    <div>
      <h1 className="text-lg font-semibold">Master Template</h1>
      <p className="mt-2 max-w-2xl text-sm text-ink/70">
        The expected weekday pattern. Generating a day copies that weekday's rows onto the date.
        Shift-click a second hour in the same row to apply one role to the whole range.
      </p>

      <div className="mt-4 flex gap-1 border-b border-border" role="tablist" aria-label="Day">
        {DAYS.map((day) => (
          <button
            key={day}
            type="button"
            role="tab"
            aria-selected={day === activeDay}
            onClick={() => setActiveDay(day)}
            className={`px-4 py-2 text-sm font-medium ${
              day === activeDay ? "border-b-2 border-accent text-accent" : "text-ink/60 hover:text-ink"
            }`}
          >
            {day}
          </button>
        ))}
      </div>

      {error ? <p className="mt-3 rounded bg-red-50 p-2 text-sm text-red-700">{error}</p> : null}

      {staffLoading || sessionsLoading ? <p className="mt-4 text-sm text-ink/70">Loading...</p> : null}
      {staffError || sessionsError ? (
        <p className="mt-4 text-sm text-red-700">Could not load the master template.</p>
      ) : null}

      {staff && sessions ? (
        <div className="mt-4">
          <ReceptionGrid
            key={activeDay}
            staff={staff}
            sessions={sessions.filter((s) => s.day === activeDay)}
            onSave={handleSave}
            onDelete={handleDelete}
            saving={saving}
          />
        </div>
      ) : null}
    </div>
  );
}
