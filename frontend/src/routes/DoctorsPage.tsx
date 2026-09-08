import { useState } from "react";

import { useDoctors, useUpdateDoctor } from "@/api/doctors";
import { useLeaveEntitlements } from "@/api/leave";
import type { ApiError, Doctor, DoctorType, SupervisionPreference } from "@/api/types";
import { useCanAdminUsers, useWriteGate } from "@/auth/AuthContext";
import { DeleteDoctorDialog } from "@/components/DeleteDoctorDialog";
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
 * passed is still active and still listed in the Active section. Ending
 * the window does not deactivate anyone.
 */
function formatWindow(doctor: Doctor): string {
  const { start_date: start, end_date: end } = doctor;
  if (start && end) return `${formatDate(start)} – ${formatDate(end)}`;
  if (start) return `from ${formatDate(start)}`;
  if (end) return `until ${formatDate(end)}`;
  return "—";
}

export function DoctorsPage() {
  const writeGate = useWriteGate();
  // Includes inactive doctors, in their own section below. This page used
  // to be active-only, which made a deactivation a one-way trip from the
  // UI - no reactivate, and (now that DELETE is a permanent purge) no way
  // to reach the delete either, for exactly the leavers it exists for.
  const { data: doctors, isLoading, isError } = useDoctors(false);
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
  const updateDoctor = useUpdateDoctor();
  const canAdminUsers = useCanAdminUsers();
  const [dialogState, setDialogState] = useState<DialogState>({ open: false });
  const [deleteTarget, setDeleteTarget] = useState<Doctor | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

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
    setActionError(null);
    setDialogState({ open: true, doctor: undefined });
  }

  function openEdit(doctor: Doctor) {
    setActionError(null);
    setDialogState({ open: true, doctor });
  }

  // Both directions are the same PATCH. DELETE is a permanent purge now
  // (routers/doctors.py) and 409s on an active doctor, so it is not the
  // deactivate path any more - it is the second step after this one.
  function handleToggleActive(doctor: Doctor) {
    setActionError(null);
    if (
      doctor.active &&
      !window.confirm(
        `Deactivate doctor "${doctor.code}"? They stop being scheduled but keep their history.`,
      )
    ) {
      return;
    }
    updateDoctor.mutate(
      { id: doctor.id, payload: { active: !doctor.active } },
      {
        onError: (err: ApiError) => {
          setActionError(
            typeof err.detail === "string" ? err.detail : "Could not update this doctor.",
          );
        },
      },
    );
  }

  function openDelete(doctor: Doctor) {
    setActionError(null);
    setDeleteTarget(doctor);
  }

  const activeDoctors = doctors?.filter((d) => d.active) ?? [];
  const inactiveDoctors = doctors?.filter((d) => !d.active) ?? [];

  // One renderer, two sections: the Active/Inactive split carries the
  // status, so a Status column would only repeat its own heading - the
  // convention ReceptionStaffPage already follows.
  function renderTable(list: Doctor[]) {
    return (
      <table className="mt-2 min-w-full text-sm">
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
        {groupDoctorsByType(list).map((group) => (
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
                      onClick={() => handleToggleActive(d)}
                      disabled={updateDoctor.isPending}
                      className="text-xs text-red-700 disabled:opacity-50"
                      {...writeGate}
                    >
                      {d.active ? "Deactivate" : "Reactivate"}
                    </button>
                    {/* Only on an inactive row (the backend 409s
                        otherwise - deactivate first, delete later) and
                        only with the user administration permission.
                        That mirrors the backend exactly: this DELETE
                        carries require_capability("user_admin") on top of
                        the clinical gate, because it is irreversible and
                        destroys history. The 403 is the real boundary;
                        this only avoids offering a button that cannot
                        work. */}
                    {!d.active && canAdminUsers ? (
                      <button
                        type="button"
                        onClick={() => openDelete(d)}
                        className="ml-3 text-xs text-red-700"
                      >
                        Delete
                      </button>
                    ) : null}
                  </td>
                </tr>
              );
            })}
          </tbody>
        ))}
      </table>
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

      {actionError ? (
        <p className="mt-3 rounded bg-red-50 p-2 text-sm text-red-700">{actionError}</p>
      ) : null}

      {isLoading ? <p className="mt-4 text-sm text-ink/70">Loading...</p> : null}
      {isError ? <p className="mt-4 text-sm text-red-700">Could not load doctors.</p> : null}

      {doctors && doctors.length === 0 ? (
        <p className="mt-4 text-sm text-ink/50">No doctors yet.</p>
      ) : null}

      {activeDoctors.length > 0 || inactiveDoctors.length > 0 ? (
        <>
          <section className="mt-4">
            <h2 className="text-sm font-semibold">Active</h2>
            {activeDoctors.length > 0 ? (
              renderTable(activeDoctors)
            ) : (
              <p className="mt-2 text-sm text-ink/50">No active doctors.</p>
            )}
          </section>

          {inactiveDoctors.length > 0 ? (
            <section className="mt-8">
              <h2 className="text-sm font-semibold text-ink/70">Inactive</h2>
              <p className="mt-1 text-xs text-ink/50">
                Not scheduled, but still on the master rota and every generated rota they were
                already on, flagged as inactive. Delete removes them and that history for good.
              </p>
              {renderTable(inactiveDoctors)}
            </section>
          ) : null}
        </>
      ) : null}

      {templateSessionsByDoctor.size > 0 ? (
        <p className="mt-2 text-xs text-amber-700">
          ⚠ Sessions/week disagrees with the doctor's week-1 master template for the doctors
          flagged above. Leave entitlement is credited from this field but charged against the
          template, so where the two disagree a leave balance accrues and is spent in different
          units - correct whichever of the two is wrong.
        </p>
      ) : null}

      {deleteTarget ? (
        <DeleteDoctorDialog
          key={deleteTarget.id}
          doctor={deleteTarget}
          open
          onOpenChange={(open) => {
            if (!open) setDeleteTarget(null);
          }}
        />
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
