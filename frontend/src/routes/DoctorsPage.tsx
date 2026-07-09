import { useState } from "react";

import { useDoctors, useSoftDeleteDoctor, useUpdateDoctor } from "@/api/doctors";
import type { Doctor } from "@/api/types";
import { DoctorFormDialog } from "@/components/DoctorFormDialog";
import { compareDoctorDisplayOrder } from "@/lib/groupDoctors";

interface DialogState {
  open: boolean;
  doctor?: Doctor;
}

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
  const { data: doctorsData, isLoading, isError } = useDoctors(true);
  // Same display convention as the rota grids: Partner/Salaried/Trainee/AHP
  // groups in that fixed order, alphabetical by code within each group.
  const doctors = doctorsData
    ? [...doctorsData].sort((a, b) =>
        compareDoctorDisplayOrder({ type: a.doctor_type, code: a.code }, { type: b.doctor_type, code: b.code }),
      )
    : doctorsData;
  const softDeleteDoctor = useSoftDeleteDoctor();
  const updateDoctor = useUpdateDoctor();
  const [dialogState, setDialogState] = useState<DialogState>({ open: false });
  const [deleteError, setDeleteError] = useState<DeleteErrorState | null>(null);

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
              <th className="py-1" />
            </tr>
          </thead>
          <tbody>
            {doctors.map((d) => (
              <tr key={d.id} className="border-t border-border">
                <td className="py-1 pr-4">{d.code}</td>
                <td className="py-1 pr-4">{d.doctor_type}</td>
                <td className="py-1 pr-4">{d.sessions_per_week}</td>
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