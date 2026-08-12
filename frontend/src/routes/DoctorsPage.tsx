import { useState } from "react";

import { useDoctors, useSoftDeleteDoctor, useUpdateDoctor } from "@/api/doctors";
import { useLeaveEntitlements } from "@/api/leave";
import type { Doctor, DoctorType, SupervisionPreference } from "@/api/types";
import { useWriteGate } from "@/auth/AuthContext";
import { DoctorFormDialog } from "@/components/DoctorFormDialog";
import { formatDate } from "@/lib/date";
import { groupDoctorsByType } from "@/lib/groupDoctors";

interface DialogState {
  open: boolean;
  doctor?: Doctor;
}

const SUPERVISION_PREFERENCES: { value: SupervisionPreference; label: string }[] = [
  { value: "none", label: "None" },
  { value: "less", label: "Less" },
  { value: "normal", label: "Normal" },
  { value: "more", label: "More" },
];

// Sessions/week is shown for the salaried-headcount types - Partner,
// Salaried and Trainee. sessions_per_week feeds the Phase 5 weighted
// clinic counter for every doctor type, so this is a display decision
// rather than a data restriction; Locum/AHP stay hidden because their
// sessions are ad hoc rather than a contracted weekly commitment, and
// their sessions_per_week is consequently not editable from this page.
const SESSIONS_TYPES: DoctorType[] = ["Partner", "Salaried", "Trainee"];

// Supervision genuinely only affects Partner/Salaried, since only those
// types are eligible Phase 9C supervisors - a Trainee is the supervisee.
const SUPERVISION_TYPES: DoctorType[] = ["Partner", "Salaried"];

function showSessions(doctorType: DoctorType): boolean {
  return SESSIONS_TYPES.includes(doctorType);
}

function showSupervision(doctorType: DoctorType): boolean {
  return SUPERVISION_TYPES.includes(doctorType);
}

/**
 * The employment window rendered compactly for the table's "Works"
 * column. Null at either end is unbounded, so all four shapes are
 * legitimate and each reads differently - "—" for a doctor with no
 * window at all (the state every doctor is in until one is set), and an
 * open-ended "from"/"until" where only one bound exists.
 *
 * Note this is independent of `active`: a doctor whose end_date has
 * passed is still active and still listed here. The page has no
 * show-inactive toggle, so a leaver stays visible until separately
 * deactivated - deliberate, not an oversight.
 */
function formatWindow(doctor: Doctor): string {
  const { start_date: start, end_date: end } = doctor;
  if (start && end) return `${formatDate(start)} – ${formatDate(end)}`;
  if (start) return `from ${formatDate(start)}`;
  if (end) return `until ${formatDate(end)}`;
  return "—";
}

interface DeleteErrorState {
  doctor: Doctor;
  message: string;
  /** Only true for the specific 409 that names PATCH active=false as the remedy. */
  offerDeactivate: boolean;
}

export function DoctorsPage() {
  const writeGate = useWriteGate();
  // Active-only per the M4 Task 6 decision: no "show inactive" toggle or
  // reactivate path yet. A doctor deactivated here (directly, or via the
  // "Deactivate instead" action below) drops out of this list and is not
  // recoverable from the UI until that toggle exists - a deliberate,
  // known limitation, not an oversight.
  const { data: doctors, isLoading, isError } = useDoctors(true);
  // Only for the sessions/week mismatch flag below - this endpoint is the
  // one place the week-1 master template is already summarised per doctor.
  // The year is immaterial to `template_sessions_per_week` (the template is
  // not year-scoped), so the current year keeps the cache key shared with
  // the leave tab rather than adding a second one.
  const { data: entitlement } = useLeaveEntitlements(new Date().getFullYear());
  const templateSessionsByDoctor = new Map(
    (entitlement?.doctors ?? [])
      .filter((row) => row.sessions_mismatch)
      .map((row) => [row.doctor_id, row.template_sessions_per_week]),
  );
  const softDeleteDoctor = useSoftDeleteDoctor();
  const updateDoctor = useUpdateDoctor();
  const [dialogState, setDialogState] = useState<DialogState>({ open: false });
  const [deleteError, setDeleteError] = useState<DeleteErrorState | null>(null);

  /**
   * Sessions/week step size. Assumption: sessions are counted in half-day
   * units, so +/- 0.5 per click. sessions_per_week is Decimal(4,1) and
   * has no server-side lower bound other than nonnegative (zod mirrors
   * that with .nonnegative()), so the only client-side clamp needed here
   * is a floor of 0.
   */
  const SESSION_STEP = 0.5;

  function adjustSessions(doctor: Doctor, direction: 1 | -1) {
    if (updateDoctor.isPending) return;
    const current = Number(doctor.sessions_per_week);
    const next = Math.max(0, current + direction * SESSION_STEP);
    if (next === current) return;
    updateDoctor.mutate({ id: doctor.id, payload: { sessions_per_week: next.toFixed(1) } });
  }

  function handleSupervisionPreferenceChange(doctor: Doctor, value: SupervisionPreference) {
    if (updateDoctor.isPending) return;
    if (value === doctor.supervision_preference) return;
    updateDoctor.mutate({ id: doctor.id, payload: { supervision_preference: value } });
  }

  function openCreate() {
    setDeleteError(null);
    setDialogState({ open: true, doctor: undefined });
  }

  function openEdit(doctor: Doctor) {
    setDeleteError(null);
    setDialogState({ open: true, doctor });
  }

  function handleDelete(doctor: Doctor) {
    if (!window.confirm(`Deactivate doctor "${doctor.code}"? This cannot be undone from here.`)) {
      return;
    }
    setDeleteError(null);
    softDeleteDoctor.mutate(doctor.id, {
      onError: (err) => {
        const message = typeof err.detail === "string" ? err.detail : "Could not deactivate this doctor.";
        // The 409 path: the doctor has committed sessions, so the DELETE
        // route itself refuses and names PATCH active=false as the
        // remedy. Without a way to fire that PATCH from here, the
        // message would describe a dead end for exactly the doctors this
        // fires on - so surface the same action as a real button.
        setDeleteError({ doctor, message, offerDeactivate: err.status === 409 });
      },
    });
  }

  function handleDeactivateInstead(doctor: Doctor) {
    updateDoctor.mutate(
      { id: doctor.id, payload: { active: false } },
      {
        onSuccess: () => setDeleteError(null),
        onError: (err) => {
          const message = typeof err.detail === "string" ? err.detail : "Could not deactivate this doctor.";
          setDeleteError({ doctor, message, offerDeactivate: false });
        },
      },
    );
  }

  return (
    <div>
      <div className="flex items-center justify-between">
        <h1 className="text-lg font-semibold">Doctors</h1>
        <button
          type="button"
          onClick={openCreate}
          className="rounded bg-accent px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
          {...writeGate}
        >
          New Doctor
        </button>
      </div>

      {deleteError ? (
        <div className="mt-3 rounded bg-red-50 p-2 text-sm text-red-700">
          <p>{deleteError.message}</p>
          {deleteError.offerDeactivate ? (
            <button
              type="button"
              onClick={() => handleDeactivateInstead(deleteError.doctor)}
              disabled={updateDoctor.isPending}
              className="mt-1 text-xs font-medium underline disabled:opacity-50"
              {...writeGate}
            >
              Deactivate instead
            </button>
          ) : null}
        </div>
      ) : null}

      {isLoading ? <p className="mt-4 text-sm text-ink/70">Loading...</p> : null}
      {isError ? <p className="mt-4 text-sm text-red-700">Could not load doctors.</p> : null}

      {doctors && doctors.length === 0 ? (
        <p className="mt-4 text-sm text-ink/50">No active doctors yet.</p>
      ) : null}

      {doctors && doctors.length > 0 ? (
        <table className="mt-4 min-w-full text-sm">
          <thead>
            <tr className="text-left text-ink/70">
              <th className="py-1 pr-4 font-medium">Code</th>
              <th className="py-1 pr-4 font-medium">Type</th>
              <th className="py-1 pr-4 font-medium">Sessions/week</th>
              <th className="py-1 pr-4 font-medium">Supervision</th>
              <th className="py-1 pr-4 font-medium">Works</th>
              <th className="py-1" />
            </tr>
          </thead>
          {groupDoctorsByType(doctors).map((group) => (
            <tbody key={group.type}>
              <tr className="border-t border-border bg-ink/5">
                <th colSpan={6} className="py-1 pr-4 text-left text-xs font-semibold uppercase text-ink/70">
                  {group.label}
                </th>
              </tr>
              {group.doctors.map((d) => {
                const sessionsVisible = showSessions(d.doctor_type);
                const templateSessions = templateSessionsByDoctor.get(d.id);
                const supervisionVisible = showSupervision(d.doctor_type);
                return (
                  <tr key={d.id} className="border-t border-border">
                    <td className="py-1 pr-4">{d.code}</td>
                    <td className="py-1 pr-4">{d.doctor_type}</td>
                    <td className="py-1 pr-4">
                      {sessionsVisible ? (
                        <div className="flex items-center gap-1">
                          <span className="tabular-nums">{d.sessions_per_week}</span>
                          <div className="flex flex-col leading-none">
                            <button
                              type="button"
                              onClick={() => adjustSessions(d, 1)}
                              disabled={updateDoctor.isPending}
                              aria-label={`Increase sessions per week for ${d.code}`}
                              className="px-1 text-[10px] text-ink/70 hover:text-accent disabled:opacity-50"
                              {...writeGate}
                            >
                              ▲
                            </button>
                            <button
                              type="button"
                              onClick={() => adjustSessions(d, -1)}
                              disabled={updateDoctor.isPending}
                              aria-label={`Decrease sessions per week for ${d.code}`}
                              className="px-1 text-[10px] text-ink/70 hover:text-accent disabled:opacity-50"
                              {...writeGate}
                            >
                              ▼
                            </button>
                          </div>
                          {templateSessions !== undefined ? (
                            <span
                              className="text-xs text-amber-700"
                              data-testid={`sessions-mismatch-${d.code}`}
                            >
                              ⚠ Template implies {templateSessions}
                            </span>
                          ) : null}
                        </div>
                      ) : (
                        <span className="text-ink/40">—</span>
                      )}
                    </td>
                    <td className="py-1 pr-4">
                      {supervisionVisible ? (
                        <select
                          aria-label={`Supervision preference for ${d.code}`}
                          value={d.supervision_preference}
                          disabled={updateDoctor.isPending}
                          onChange={(e) =>
                            handleSupervisionPreferenceChange(d, e.target.value as SupervisionPreference)
                          }
                          className="rounded border border-border p-1 text-sm disabled:opacity-50"
                          {...writeGate}
                        >
                          {SUPERVISION_PREFERENCES.map((p) => (
                            <option key={p.value} value={p.value}>
                              {p.label}
                            </option>
                          ))}
                        </select>
                      ) : (
                        <span className="text-ink/40">—</span>
                      )}
                    </td>
                    <td className="py-1 pr-4 whitespace-nowrap">
                      <span
                        aria-label={`Employment window for ${d.code}`}
                        className={d.start_date || d.end_date ? undefined : "text-ink/40"}
                      >
                        {formatWindow(d)}
                      </span>
                    </td>
                    <td className="py-1">
                      <button
                        type="button"
                        onClick={() => openEdit(d)}
                        className="mr-3 text-xs text-accent disabled:opacity-50"
                        {...writeGate}
                      >
                        Edit
                      </button>
                      <button
                        type="button"
                        onClick={() => handleDelete(d)}
                        className="text-xs text-red-700 disabled:opacity-50"
                        {...writeGate}
                      >
                        Delete
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          ))}
        </table>
      ) : null}

      {templateSessionsByDoctor.size > 0 ? (
        <p className="mt-2 text-xs text-amber-700">
          ⚠ Sessions/week disagrees with the doctor's week-1 master template for the doctors
          flagged above. Leave entitlement is credited from this field but charged against the
          template, so where the two disagree a leave balance accrues and is spent in different
          units - correct whichever of the two is wrong.
        </p>
      ) : null}

      {dialogState.open ? (
        <DoctorFormDialog
          key={dialogState.doctor?.id ?? "new"}
          doctor={dialogState.doctor}
          open={dialogState.open}
          onOpenChange={(open) => setDialogState((s) => ({ ...s, open }))}
        />
      ) : null}
    </div>
  );
}
