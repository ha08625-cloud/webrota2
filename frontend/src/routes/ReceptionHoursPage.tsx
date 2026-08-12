import { useReceptionMasterSessions, useReceptionStaff } from "@/api/reception";
import type { ReceptionMasterSession, ReceptionStaff } from "@/api/types";

/**
 * Weekly working hours per staff member, derived from the master template:
 * every template row is a scheduled half-hour slot, and a `not_working`
 * role tags a slot as scheduled-but-not-working (see
 * architecture-reception.md) without deleting it. Working hours are
 * therefore (all rows - not_working rows) * 0.5h. Rows the staff member
 * has no session for at all are already excluded, since only rows exist
 * in the data - there is nothing to subtract for them.
 */
function computeWeeklyHours(sessions: ReceptionMasterSession[]): Map<number, number> {
  const slotCounts = new Map<number, number>();
  for (const session of sessions) {
    if (session.role === "not_working") continue;
    slotCounts.set(session.staff_id, (slotCounts.get(session.staff_id) ?? 0) + 1);
  }
  const hours = new Map<number, number>();
  for (const [staffId, slots] of slotCounts) {
    hours.set(staffId, slots * 0.5);
  }
  return hours;
}

function formatHours(hours: number): string {
  return Number.isInteger(hours) ? `${hours}` : hours.toFixed(1);
}

export function ReceptionHoursPage() {
  const { data: staff, isLoading: staffLoading, isError: staffError } = useReceptionStaff();
  const { data: sessions, isLoading: sessionsLoading, isError: sessionsError } = useReceptionMasterSessions();

  const isLoading = staffLoading || sessionsLoading;
  const isError = staffError || sessionsError;

  const weeklyHours = sessions ? computeWeeklyHours(sessions) : new Map<number, number>();

  const rows: ReceptionStaff[] = [...(staff ?? [])].sort((a, b) => a.name.localeCompare(b.name));

  return (
    <div>
      <h1 className="text-lg font-semibold">Hours</h1>
      <p className="mt-2 max-w-2xl text-sm text-ink/70">
        Weekly working hours per staff member, derived from the master template: every scheduled
        half-hour slot counts, except those tagged "Not working".
      </p>

      {isLoading ? <p className="mt-4 text-sm text-ink/70">Loading...</p> : null}
      {isError ? <p className="mt-4 text-sm text-red-700">Could not load hours.</p> : null}

      {staff ? (
        <table className="mt-4 text-sm">
          <thead>
            <tr>
              <th className="py-1 pr-4 text-left font-medium text-ink/70">Staff</th>
              <th className="py-1 pr-4 text-left font-medium text-ink/70">Hours / week</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((member) => (
              <tr key={member.id} className="border-t border-border">
                <td className="py-1 pr-4 whitespace-nowrap">{member.name}</td>
                <td className="py-1 pr-4">{formatHours(weeklyHours.get(member.id) ?? 0)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}
    </div>
  );
}
