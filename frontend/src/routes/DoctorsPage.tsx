import { useState } from "react";

import { useDoctors, useSoftDeleteDoctor, useUpdateDoctor } from "@/api/doctors";
import type { Doctor, SupervisionPreference } from "@/api/types";
import { DoctorFormDialog } from "@/components/DoctorFormDialog";
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

interface DeleteErrorState {
  doctor: Doctor;
  message: string;
  /** Only true for the specific 409 that names PATCH active=false as the remedy. */
  offerDeactivate: boolean;
}

export function DoctorsPage() {
  // Active-only per the M4 Task 6 decision: no "show inactive" toggle or
  // reactivate path yet. A doctor deactivated here (directly, or via the
  // "Deactivate instead" action below) drops out of this list and is not
  // recoverable from the UI until that toggle exists - a deliberate,
  // known limitation, not an oversight.
  const { data: doctors, isLoading, isError } = useDoctors(true);
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
          className="rounded bg-accent px-4 py-2 text-sm font-medium text-white"
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
              <th className="py-1" />
            </tr>
          </thead>
          {groupDoctorsByType(doctors).map((group) => (
            <tbody key={group.type}>
              <tr className="border-t border-border bg-ink/5">
                <th colSpan={5} className="py-1 pr-4 text-left text-xs font-semibold uppercase text-ink/70">
                  {group.label}
                </th>
              </tr>
              {group.doctors.map((d) => (
                <tr key={d.id} className="border-t border-border">
                  <td className="py-1 pr-4">{d.code}</td>
                  <td className="py-1 pr-4">{d.doctor_type}</td>
                  <td className="py-1 pr-4">
                    <div className="flex items-center gap-1">
                      <span className="tabular-nums">{d.sessions_per_week}</span>
                      <div className="flex flex-col leading-none">
                        <button
                          type="button"
                          onClick={() => adjustSessions(d, 1)}
                          disabled={updateDoctor.isPending}
                          aria-label={`Increase sessions per week for ${d.code}`}
                          className="px-1 text-[10px] text-ink/70 hover:text-accent disabled:opacity-50"
                        >
                          ▲
                        </button>
                        <button
                          type="button"
                          onClick={() => adjustSessions(d, -1)}
                          disabled={updateDoctor.isPending}
                          aria-label={`Decrease sessions per week for ${d.code}`}
                          className="px-1 text-[10px] text-ink/70 hover:text-accent disabled:opacity-50"
                        >
                          ▼
                        </button>
                      </div>
                    </div>
                  </td>
                  <td className="py-1 pr-4">
                    <select
                      aria-label={`Supervision preference for ${d.code}`}
                      value={d.supervision_preference}
                      disabled={updateDoctor.isPending}
                      onChange={(e) =>
                        handleSupervisionPreferenceChange(d, e.target.value as SupervisionPreference)
                      }
                      className="rounded border border-border p-1 text-sm disabled:opacity-50"
                    >
                      {SUPERVISION_PREFERENCES.map((p) => (
                        <option key={p.value} value={p.value}>
                          {p.label}
                        </option>
                      ))}
                    </select>
                  </td>
                  <td className="py-1">
                    <button type="button" onClick={() => openEdit(d)} className="mr-3 text-xs text-accent">
                      Edit
                    </button>
                    <button type="button" onClick={() => handleDelete(d)} className="text-xs text-red-700">
                      Delete
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          ))}
        </table>
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