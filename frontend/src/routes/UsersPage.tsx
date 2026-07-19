import { useState } from "react";

import { useUpdateUser, useUsers } from "@/api/users";
import type { ApiError, AuthUser } from "@/api/types";
import { UserFormDialog } from "@/components/UserFormDialog";
import { ToastDisplay, useToast } from "@/components/Toast";

interface DialogState {
  open: boolean;
  user?: AuthUser;
}

export function UsersPage() {
  // Unlike DoctorsPage (active-only), this list always includes inactive
  // users - deactivation must be reversible from here, since there is no
  // other recovery path once a user is locked out (auth plan, Design
  // Decision 8: a teammate resets you via this page).
  const { data: users, isLoading, isError } = useUsers();
  const updateUser = useUpdateUser();
  const [dialogState, setDialogState] = useState<DialogState>({ open: false });
  const { toast, showToast } = useToast();

  function openCreate() {
    setDialogState({ open: true, user: undefined });
  }

  function openEdit(user: AuthUser) {
    setDialogState({ open: true, user });
  }

  function handleToggleActive(user: AuthUser) {
    const nextActive = !user.active;
    if (!nextActive && !window.confirm(`Deactivate "${user.name}"? They will be signed out immediately.`)) {
      return;
    }
    updateUser.mutate(
      { id: user.id, payload: { active: nextActive } },
      {
        onError: (err: ApiError) => {
          // Surfaces the backend's 409 here (auth plan, Design Decision
          // 9: deactivating the last remaining active user is rejected)
          // as a toast rather than a form error, since this action has
          // no form of its own.
          const message = typeof err.detail === "string" ? err.detail : "Could not update this user.";
          showToast(message);
        },
      },
    );
  }

  return (
    <div>
      <div className="flex items-center justify-between">
        <h1 className="text-lg font-semibold">Users</h1>
        <button
          type="button"
          onClick={openCreate}
          className="rounded bg-accent px-4 py-2 text-sm font-medium text-white"
        >
          New User
        </button>
      </div>

      {isLoading ? <p className="mt-4 text-sm text-ink/70">Loading...</p> : null}
      {isError ? <p className="mt-4 text-sm text-red-700">Could not load users.</p> : null}

      {users && users.length === 0 ? <p className="mt-4 text-sm text-ink/50">No users yet.</p> : null}

      {users && users.length > 0 ? (
        <table className="mt-4 min-w-full text-sm">
          <thead>
            <tr className="text-left text-ink/70">
              <th className="py-1 pr-4 font-medium">Name</th>
              <th className="py-1 pr-4 font-medium">Email</th>
              <th className="py-1" />
            </tr>
          </thead>
          <tbody>
            {users.map((u) => (
              <tr key={u.id} className="border-t border-border">
                <td className="py-1 pr-4">
                  {u.name}
                  {!u.active ? <span className="text-ink/50"> (inactive)</span> : null}
                </td>
                <td className="py-1 pr-4">{u.email}</td>
                <td className="py-1">
                  <button type="button" onClick={() => openEdit(u)} className="mr-3 text-xs text-accent">
                    Edit
                  </button>
                  <button
                    type="button"
                    onClick={() => handleToggleActive(u)}
                    disabled={updateUser.isPending}
                    className="text-xs text-red-700 disabled:opacity-50"
                  >
                    {u.active ? "Deactivate" : "Reactivate"}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}

      {dialogState.open ? (
        <UserFormDialog
          key={dialogState.user?.id ?? "new"}
          user={dialogState.user}
          open={dialogState.open}
          onOpenChange={(open) => setDialogState((s) => ({ ...s, open }))}
        />
      ) : null}

      <ToastDisplay message={toast?.message} />
    </div>
  );
}