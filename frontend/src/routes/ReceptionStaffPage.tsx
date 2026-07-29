import { useState } from "react";

import { useDeactivateReceptionStaff, useReceptionStaff, useUpdateReceptionStaff } from "@/api/reception";
import type { ApiError, ReceptionStaff } from "@/api/types";
import { ReceptionStaffFormDialog } from "@/components/ReceptionStaffFormDialog";

interface DialogState {
  open: boolean;
  staff?: ReceptionStaff;
}

export function ReceptionStaffPage() {
  // Unlike DoctorsPage (active-only, no way back), this always includes
  // inactive staff - this page is the only management surface for
  // reception staff (reception rota plan, Task 6), so deactivating
  // someone here must not be a dead end, the UsersPage convention.
  const { data: staff, isLoading, isError } = useReceptionStaff(true);
  const updateStaff = useUpdateReceptionStaff();
  const deactivateStaff = useDeactivateReceptionStaff();
  const [dialogState, setDialogState] = useState<DialogState>({ open: false });
  const [actionError, setActionError] = useState<string | null>(null);

  function openCreate() {
    setActionError(null);
    setDialogState({ open: true, staff: undefined });
  }

  function openEdit(member: ReceptionStaff) {
    setActionError(null);
    setDialogState({ open: true, staff: member });
  }

  function handleDeactivate(member: ReceptionStaff) {
    if (!window.confirm(`Deactivate reception staff "${member.code}"?`)) return;
    setActionError(null);
    deactivateStaff.mutate(member.id, {
      onError: (err: ApiError) => {
        setActionError(typeof err.detail === "string" ? err.detail : "Could not deactivate this staff member.");
      },
    });
  }

  function handleReactivate(member: ReceptionStaff) {
    setActionError(null);
    updateStaff.mutate(
      { id: member.id, payload: { active: true } },
      {
        onError: (err: ApiError) => {
          setActionError(typeof err.detail === "string" ? err.detail : "Could not reactivate this staff member.");
        },
      },
    );
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
            {staff.map((member) => (
              <tr key={member.id} className="border-t border-border">
                <td className="py-1 pr-4">{member.code}</td>
                <td className="py-1 pr-4">{member.name}</td>
                <td className="py-1 pr-4">
                  {member.active ? "Active" : <span className="text-ink/50">(inactive)</span>}
                </td>
                <td className="py-1">
                  <button type="button" onClick={() => openEdit(member)} className="mr-3 text-xs text-accent">
                    Edit
                  </button>
                  {member.active ? (
                    <button
                      type="button"
                      onClick={() => handleDeactivate(member)}
                      disabled={deactivateStaff.isPending}
                      className="text-xs text-red-700 disabled:opacity-50"
                    >
                      Deactivate
                    </button>
                  ) : (
                    <button
                      type="button"
                      onClick={() => handleReactivate(member)}
                      disabled={updateStaff.isPending}
                      className="text-xs text-accent disabled:opacity-50"
                    >
                      Reactivate
                    </button>
                  )}
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
