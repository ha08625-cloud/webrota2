import { useState } from "react";

import { useReceptionStaff, useUpdateReceptionStaff } from "@/api/reception";
import type { ApiError, ReceptionStaff } from "@/api/types";
import { useIsManager, useWriteGate } from "@/auth/AuthContext";
import { DeleteReceptionStaffDialog } from "@/components/DeleteReceptionStaffDialog";
import { ReceptionStaffFormDialog } from "@/components/ReceptionStaffFormDialog";

interface DialogState {
  open: boolean;
  staff?: ReceptionStaff;
}

export function ReceptionStaffPage() {
  const writeGate = useWriteGate();
  // Always includes inactive - unlike DoctorsPage (active-only), this is
  // the only management surface for reception staff (reception rota plan,
  // Task 6), so a deactivation must have a visible way back, the same
  // convention UsersPage follows.
  const { data: staff, isLoading, isError } = useReceptionStaff(true);
  const updateStaff = useUpdateReceptionStaff();
  const isManager = useIsManager();
  const [dialogState, setDialogState] = useState<DialogState>({ open: false });
  const [deleteTarget, setDeleteTarget] = useState<ReceptionStaff | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const isToggling = updateStaff.isPending;

  function openCreate() {
    setActionError(null);
    setDialogState({ open: true, staff: undefined });
  }

  function openEdit(member: ReceptionStaff) {
    setActionError(null);
    setDialogState({ open: true, staff: member });
  }

  // Both directions are the same PATCH: DELETE is a permanent purge now
  // (routers/reception_staff.py), not a soft delete, and would 409 here.
  function handleToggleActive(member: ReceptionStaff) {
    setActionError(null);
    const onError = (err: ApiError) => {
      const message = typeof err.detail === "string" ? err.detail : "Could not update this staff member.";
      setActionError(message);
    };

    if (member.active && !window.confirm(`Deactivate reception staff "${member.code}"?`)) return;

    updateStaff.mutate({ id: member.id, payload: { active: !member.active } }, { onError });
  }

  function openDelete(member: ReceptionStaff) {
    setActionError(null);
    setDeleteTarget(member);
  }

  const activeStaff = staff?.filter((s) => s.active) ?? [];
  const inactiveStaff = staff?.filter((s) => !s.active) ?? [];

  function renderRows(members: ReceptionStaff[]) {
    return members.map((s) => (
      <tr key={s.id} className="border-t border-border">
        <td className="py-1 pr-4">{s.code}</td>
        <td className="py-1 pr-4">{s.name}</td>
        <td className="py-1">
          <button
            type="button"
            onClick={() => openEdit(s)}
            className="mr-3 text-xs text-accent disabled:opacity-50"
            {...writeGate}
          >
            Edit
          </button>
          <button
            type="button"
            onClick={() => handleToggleActive(s)}
            disabled={isToggling}
            className="text-xs text-red-700 disabled:opacity-50"
            {...writeGate}
          >
            {s.active ? "Deactivate" : "Reactivate"}
          </button>
          {/* Only on an inactive row (the backend 409s otherwise -
              deactivate first, delete later) and only for a
              manager, matching how App.tsx hides Users and Audit
              Log below manager. The 403 is the real boundary. */}
          {!s.active && isManager ? (
            <button
              type="button"
              onClick={() => openDelete(s)}
              className="ml-3 text-xs text-red-700"
            >
              Delete
            </button>
          ) : null}
        </td>
      </tr>
    ));
  }

  // The two lists carry the active/inactive distinction that used to be a
  // Status column, so the column would only repeat its own heading.
  function renderTable(members: ReceptionStaff[]) {
    return (
      <table className="mt-2 min-w-full text-sm">
        <thead>
          <tr className="text-left text-ink/70">
            <th className="py-1 pr-4 font-medium">Code</th>
            <th className="py-1 pr-4 font-medium">Name</th>
            <th className="py-1" />
          </tr>
        </thead>
        <tbody>{renderRows(members)}</tbody>
      </table>
    );
  }

  return (
    <div>
      <div className="flex items-center justify-between">
        <h1 className="text-lg font-semibold">Reception Staff</h1>
        <button
          type="button"
          onClick={openCreate}
          className="rounded bg-accent px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
          {...writeGate}
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
        <>
          <section className="mt-4">
            <h2 className="text-sm font-semibold">Active</h2>
            {activeStaff.length > 0 ? (
              renderTable(activeStaff)
            ) : (
              <p className="mt-2 text-sm text-ink/50">No active reception staff.</p>
            )}
          </section>

          {inactiveStaff.length > 0 ? (
            <section className="mt-8">
              <h2 className="text-sm font-semibold text-ink/70">Inactive</h2>
              {renderTable(inactiveStaff)}
            </section>
          ) : null}
        </>
      ) : null}

      {dialogState.open ? (
        <ReceptionStaffFormDialog
          key={dialogState.staff?.id ?? "new"}
          staff={dialogState.staff}
          open={dialogState.open}
          onOpenChange={(open) => setDialogState((s) => ({ ...s, open }))}
        />
      ) : null}

      {deleteTarget ? (
        <DeleteReceptionStaffDialog
          key={deleteTarget.id}
          staff={deleteTarget}
          open
          onOpenChange={(open) => {
            if (!open) setDeleteTarget(null);
          }}
        />
      ) : null}
    </div>
  );
}
