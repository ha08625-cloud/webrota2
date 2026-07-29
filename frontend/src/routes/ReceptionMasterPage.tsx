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

  const saving = createSession.isPending || updateSession.isPending || deleteSession.isPending;

  function handleSave({ staffId, hour, session, role, note }: ReceptionSavePayload<ReceptionMasterSession>) {
    setError(null);
    const onError = (err: ApiError) => setError(apiErrorMessage(err, "Could not save this slot."));
    if (session) {
      updateSession.mutate({ sessionId: session.session_id, role, note }, { onError });
    } else {
      createSession.mutate({ staffId, day: activeDay, hour, role, note }, { onError });
    }
  }

  function handleDelete(session: ReceptionMasterSession) {
    setError(null);
    deleteSession.mutate(session.session_id, {
      onError: (err: ApiError) => setError(apiErrorMessage(err, "Could not remove this slot.")),
    });
  }

  return (
    <div>
      <h1 className="text-lg font-semibold">Master Template</h1>
      <p className="mt-2 max-w-2xl text-sm text-ink/70">
        The expected weekday pattern. Generating a day copies that weekday's rows onto the date.
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
