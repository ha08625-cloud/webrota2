import { useState } from "react";

import type { ApiError, Doctor } from "@/api/types";
import { useWriteGate } from "@/auth/AuthContext";

import { useNurses, useUpdateNurse } from "./api";
import { DeleteNurseDialog } from "./DeleteNurseDialog";
import { NurseFormDialog } from "./NurseFormDialog";

interface DialogState {
  open: boolean;
  nurse?: Doctor;
}

/**
 * Nurse staff administration - the section's second page.
 *
 * Modelled on `ReceptionStaffPage`, with one difference that must not be
 * copied back by reflex: Delete is gated on **write only**, not on
 * `useCanAdminUsers()`. `DELETE /nurse-rota/nurses/{id}` deliberately
 * carries no `user_admin` dependency, because a nurse_rota-only login that
 * could not delete would not have this feature at all; the backend
 * docstring states the cost of that (the login it widens most is
 * `rota_admin`). Copying reception's `canAdminUsers` line here would
 * silently disable the feature for exactly the login it exists for.
 *
 * Writes sit behind the Nurse Rota edit lock like every other write in
 * this section - `nurse_rota` is in LOCKABLE_AREAS and `main.py` attaches
 * `require_edit_lock` off the area, so there is no per-endpoint escape.
 */
export function NurseStaffPage() {
  const writeGate = useWriteGate();
  // Always includes inactive: this is the only management surface for
  // nurses, so a deactivation must have a visible way back.
  const { data: nurses, isLoading, isError } = useNurses(true);
  const updateNurse = useUpdateNurse();
  const [dialogState, setDialogState] = useState<DialogState>({ open: false });
  const [deleteTarget, setDeleteTarget] = useState<Doctor | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const isToggling = updateNurse.isPending;

  function openCreate() {
    setActionError(null);
    setDialogState({ open: true, nurse: undefined });
  }

  function openEdit(nurse: Doctor) {
    setActionError(null);
    setDialogState({ open: true, nurse });
  }

  // Both directions are the same PATCH: DELETE is a permanent purge, not a
  // soft delete, and 409s on an active row.
  function handleToggleActive(nurse: Doctor) {
    setActionError(null);
    const onError = (err: ApiError) => {
      const message = typeof err.detail === "string" ? err.detail : "Could not update this nurse.";
      setActionError(message);
    };

    if (nurse.active && !window.confirm(`Deactivate nurse "${nurse.code}"?`)) return;

    updateNurse.mutate({ id: nurse.id, payload: { active: !nurse.active } }, { onError });
  }

  function openDelete(nurse: Doctor) {
    setActionError(null);
    setDeleteTarget(nurse);
  }

  const activeNurses = nurses?.filter((n) => n.active) ?? [];
  const inactiveNurses = nurses?.filter((n) => !n.active) ?? [];

  function renderDates(nurse: Doctor) {
    if (!nurse.start_date && !nurse.end_date) return "-";
    return `${nurse.start_date ?? "-"} to ${nurse.end_date ?? "-"}`;
  }

  function renderRows(rows: Doctor[]) {
    return rows.map((n) => (
      <tr key={n.id} className="border-t border-border">
        <td className="py-1 pr-4">{n.code}</td>
        <td className="py-1 pr-4 text-ink/70">{renderDates(n)}</td>
        <td className="py-1">
          <button
            type="button"
            onClick={() => openEdit(n)}
            className="mr-3 text-xs text-accent disabled:opacity-50"
            {...writeGate}
          >
            Edit
          </button>
          <button
            type="button"
            onClick={() => handleToggleActive(n)}
            disabled={isToggling}
            className="text-xs text-red-700 disabled:opacity-50"
            {...writeGate}
          >
            {n.active ? "Deactivate" : "Reactivate"}
          </button>
          {/* Only on an inactive row - the backend 409s otherwise, which
              is the deliberate two-step: deactivate first, delete later. */}
          {!n.active ? (
            <button
              type="button"
              onClick={() => openDelete(n)}
              className="ml-3 text-xs text-red-700 disabled:opacity-50"
              {...writeGate}
            >
              Delete
            </button>
          ) : null}
        </td>
      </tr>
    ));
  }

  // The Active/Inactive split carries the status, so a Status column would
  // only repeat its own heading.
  function renderTable(rows: Doctor[]) {
    return (
      <table className="mt-2 min-w-full text-sm">
        <thead>
          <tr className="text-left text-ink/70">
            <th className="py-1 pr-4 font-medium">Name</th>
            <th className="py-1 pr-4 font-medium">Employment dates</th>
            <th className="py-1" />
          </tr>
        </thead>
        <tbody>{renderRows(rows)}</tbody>
      </table>
    );
  }

  return (
    <div>
      <div className="flex items-center justify-between">
        <h1 className="text-lg font-semibold">Nurse Staff</h1>
        <button
          type="button"
          onClick={openCreate}
          className="rounded bg-accent px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
          {...writeGate}
        >
          New Nurse
        </button>
      </div>

      {actionError ? <p className="mt-3 rounded bg-red-50 p-2 text-sm text-red-700">{actionError}</p> : null}

      {isLoading ? <p className="mt-4 text-sm text-ink/70">Loading...</p> : null}
      {isError ? <p className="mt-4 text-sm text-red-700">Could not load nurses.</p> : null}

      {nurses && nurses.length === 0 ? (
        <p className="mt-4 text-sm text-ink/50">No nurses yet.</p>
      ) : null}

      {nurses && nurses.length > 0 ? (
        <>
          <section className="mt-4">
            <h2 className="text-sm font-semibold">Active</h2>
            {activeNurses.length > 0 ? (
              renderTable(activeNurses)
            ) : (
              <p className="mt-2 text-sm text-ink/50">No active nurses.</p>
            )}
          </section>

          {inactiveNurses.length > 0 ? (
            <section className="mt-8">
              <h2 className="text-sm font-semibold text-ink/70">Inactive</h2>
              {renderTable(inactiveNurses)}
            </section>
          ) : null}
        </>
      ) : null}

      {dialogState.open ? (
        <NurseFormDialog
          key={dialogState.nurse?.id ?? "new"}
          nurse={dialogState.nurse}
          open={dialogState.open}
          onOpenChange={(open) => setDialogState((s) => ({ ...s, open }))}
        />
      ) : null}

      {deleteTarget ? (
        <DeleteNurseDialog
          key={deleteTarget.id}
          nurse={deleteTarget}
          open
          onOpenChange={(open) => {
            if (!open) setDeleteTarget(null);
          }}
        />
      ) : null}
    </div>
  );
}
