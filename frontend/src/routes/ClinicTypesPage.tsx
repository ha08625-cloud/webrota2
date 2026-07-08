import { useState } from "react";

import { useClinicTypes, useDeleteClinicType } from "@/api/clinicTypes";
import type { ClinicType } from "@/api/types";
import { ClinicTypeFormDialog } from "@/components/ClinicTypeFormDialog";

interface DialogState {
  open: boolean;
  clinicType?: ClinicType;
}

export function ClinicTypesPage() {
  const { data: clinicTypes, isLoading, isError } = useClinicTypes();
  const deleteClinicType = useDeleteClinicType();
  const [dialogState, setDialogState] = useState<DialogState>({ open: false });
  const [deleteError, setDeleteError] = useState<string | null>(null);

  function openCreate() {
    setDeleteError(null);
    setDialogState({ open: true, clinicType: undefined });
  }

  function openEdit(clinicType: ClinicType) {
    setDeleteError(null);
    setDialogState({ open: true, clinicType });
  }

  function handleDelete(clinicType: ClinicType) {
    if (!window.confirm(`Delete clinic type "${clinicType.name}"? This cannot be undone.`)) {
      return;
    }
    setDeleteError(null);
    deleteClinicType.mutate(clinicType.id, {
      onError: (err) => {
        setDeleteError(typeof err.detail === "string" ? err.detail : "Could not delete this clinic type.");
      },
    });
  }

  return (
    <div>
      <div className="flex items-center justify-between">
        <h1 className="text-lg font-semibold">Clinic Types</h1>
        <button
          type="button"
          onClick={openCreate}
          className="rounded bg-accent px-4 py-2 text-sm font-medium text-white"
        >
          New Clinic Type
        </button>
      </div>

      {deleteError ? <p className="mt-3 text-sm text-red-700">{deleteError}</p> : null}

      {isLoading ? <p className="mt-4 text-sm text-ink/70">Loading...</p> : null}
      {isError ? <p className="mt-4 text-sm text-red-700">Could not load clinic types.</p> : null}

      {clinicTypes && clinicTypes.length === 0 ? (
        <p className="mt-4 text-sm text-ink/50">
          No clinic types yet. Nothing will generate until at least one is added.
        </p>
      ) : null}

      {clinicTypes && clinicTypes.length > 0 ? (
        <table className="mt-4 min-w-full text-sm">
          <thead>
            <tr className="text-left text-ink/70">
              <th className="py-1 pr-4 font-medium">Name</th>
              <th className="py-1 pr-4 font-medium">Priority</th>
              <th className="py-1 pr-4 font-medium">Enabled</th>
              <th className="py-1 pr-4 font-medium">Room required</th>
              <th className="py-1 pr-4 font-medium">Category</th>
              <th className="py-1 pr-4 font-medium">Schedule slots</th>
              <th className="py-1" />
            </tr>
          </thead>
          <tbody>
            {clinicTypes.map((ct) => (
              <tr key={ct.id} className="border-t border-border">
                <td className="py-1 pr-4">{ct.name}</td>
                <td className="py-1 pr-4">{ct.clinic_priority}</td>
                <td className="py-1 pr-4">{ct.is_enabled ? "Yes" : "No"}</td>
                <td className="py-1 pr-4">{ct.room_required ? "Yes" : "No"}</td>
                <td className="py-1 pr-4">{ct.category ?? "-"}</td>
                <td className="py-1 pr-4">{ct.schedules.length}</td>
                <td className="py-1">
                  <button type="button" onClick={() => openEdit(ct)} className="mr-3 text-xs text-accent">
                    Edit
                  </button>
                  <button type="button" onClick={() => handleDelete(ct)} className="text-xs text-red-700">
                    Delete
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}

      {dialogState.open ? (
        <ClinicTypeFormDialog
          key={dialogState.clinicType?.id ?? "new"}
          clinicType={dialogState.clinicType}
          open={dialogState.open}
          onOpenChange={(open) => setDialogState((s) => ({ ...s, open }))}
        />
      ) : null}
    </div>
  );
}