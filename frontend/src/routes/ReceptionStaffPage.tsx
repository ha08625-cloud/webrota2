import { useState } from "react";

import { useDeactivateReceptionStaff, useReceptionStaff, useUpdateReceptionStaff } from "@/api/reception";
import type { ApiError, ReceptionStaff } from "@/api/types";
import { ReceptionStaffFormDialog } from "@/components/ReceptionStaffFormDialog";

interface DialogState {
  open: boolean;
  staff?: ReceptionStaff;
}

export function ReceptionStaffPage() {
  // Always includes inactive - unlike DoctorsPage (active-only), this is
  // the only management surface for reception staff (reception rota plan,
  // Task 6), so a deactivation must have a visible way back, the same
  // convention UsersPage follows.
  const { data: staff, isLoading, isError } = useReceptionStaff(true);
  const deactivateStaff = useDeactivateReceptionStaff();
  const updateStaff = useUpdateReceptionStaff();
  const [dialogState, setDialogState] = useState<DialogState>({ open: false });
  const [actionError, setActionError] = useState<string | null>(null);

  const isToggling = deactivateStaff.isPending || updateStaff.isPending;

  function openCreate() {
    setActionError(null);
    setDialogState({ open: true, staff: undefined });
  }

  function openEdit(member: ReceptionStaff) {
    setActionError(null);
    setDialogState({ open: true, staff: member });
  }

  function handleToggleActive(member: ReceptionStaff) {
    setActionError(null);
    const onError = (err: ApiError) => {
      const message = typeof err.detail === "string" ? err.detail : "Could not update this staff member.";
      setActionError(message);
    };

    if (member.active) {
      if (!window.confirm(`Deactivate reception staff "${member.code}"?`)) return;
      deactivateStaff.mutate(member.id, { onError });
      return;
    }

    updateStaff.mutate({ id: member.id, payload: { active: true } }, { onError });
  }

  return (
    <div>
      <div className="flex items-center justify-between">
        <h1 className="text-lg font-semibold">Reception Staff</h1>
        <button
          type="button"
          onClick={openCreate}
          className="rounded bg-accent px-4 py-2 text-sm font-medium text-white"
        >
          New Reception Staff
        </button>
      </div>

      {actionError ? <p className="mt-3 rounded bg-red-50 p-2 text-sm text-red-700">{actionError}</p> : null}

      {isLoading ? <p className="mt-4 text-sm text-ink/70">Loading...</p> : null}
      {isError ? <p className="mt-4 text-sm text-red-700">Could not load reception staff.</p> : null}

      {staff && staff.length === 0 ? (
        <p className="mt-4 text-sm text-ink/50">No reception staff yet.</p>
      ) : null}

      {staff && staff.length > 0 ? (
        <table className="mt-4 min-w-full text-sm">
          <thead>
            <tr className="text-left text-ink/70">
              <th className="py-1 pr-4 font-medium">Code</th>
              <th className="py-1 pr-4 font-medium">Name</th>
              <th className="py-1 pr-4 font-medium">Status</th>
              <th className="py-1" />
            </tr>
          </thead>
          <tbody>
            {staff.map((s) => (
              <tr key={s.id} className="border-t border-border">
                <td className="py-1 pr-4">{s.code}</td>
                <td className="py-1 pr-4">{s.name}</td>
                <td className="py-1 pr-4">{s.active ? "Active" : "Inactive"}</td>
                <td className="py-1">
                  <button type="button" onClick={() => openEdit(s)} className="mr-3 text-xs text-accent">
                    Edit
                  </button>
                  <button
                    type="button"
                    onClick={() => handleToggleActive(s)}
                    disabled={isToggling}
                    className="text-xs text-red-700 disabled:opacity-50"
                  >
                    {s.active ? "Deactivate" : "Reactivate"}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}

      {dialogState.open ? (
        <ReceptionStaffFormDialog
          key={dialogState.staff?.id ?? "new"}
          staff={dialogState.staff}
          open={dialogState.open}
          onOpenChange={(open) => setDialogState((s) => ({ ...s, open }))}
        />
      ) : null}
    </div>
  );
}
