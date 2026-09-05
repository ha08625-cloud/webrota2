import { useState } from "react";

import { useUpdateUser, useUsers } from "@/api/users";
import type { AccessLevel, ApiError, AuthUser, StaffLink } from "@/api/types";
import { useIsManager } from "@/auth/AuthContext";
import { UserFormDialog } from "@/components/UserFormDialog";
import { ToastDisplay, useToast } from "@/components/Toast";
import { ACCESS_LEVELS, accessLevelLabel } from "@/lib/accessLevels";

interface DialogState {
  open: boolean;
  user?: AuthUser;
}

export function UsersPage() {
  // Manager-only, matching the backend: GET /users itself 403s below that
  // tier, so a non-manager would otherwise get a bare "Could not load
  // users". The nav entry is hidden for them too (App.tsx), but the route
  // stays registered, so a bookmarked link has to land somewhere sane
  // rather than on a broken list.
  const isManager = useIsManager();

  if (!isManager) {
    return (
      <div>
        <h1 className="text-lg font-semibold">Users</h1>
        <p className="mt-4 text-sm text-ink/70">
          You do not have access to user management. Ask a manager if you need an account changed.
        </p>
        <p className="mt-2 text-sm text-ink/70">
          You can change your own password from "Change password" in the header.
        </p>
      </div>
    );
  }

  return <UsersTable />;
}

/**
 * Read-only summary of the staff link - the doctor code, the reception
 * code, both, or an em dash. Editing it is the dialog's job. An inactive
 * link is marked rather than hidden: it is a supported state (the staff
 * row was soft-deleted, or hard-deleted reception staff nulled the link
 * elsewhere), and showing it is how a manager notices it needs attention.
 */
function linkedLabel(user: AuthUser): string {
  const parts = [user.linked_doctor, user.linked_reception_staff]
    .filter((link): link is StaffLink => link !== null)
    .map((link) => (link.active ? link.code : `${link.code} (inactive)`));
  return parts.length > 0 ? parts.join(", ") : "\u2014";
}

function UsersTable() {
  // Unlike DoctorsPage (active-only), this list always includes inactive
  // users - deactivation must be reversible from here. Recovery from
  // locking every manager out is not a UI path at all: the backend
  // refuses to remove the last active manager (409), and a database that
  // has somehow lost them all is recovered by re-running seed_users.py.
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

  // Shared by both row-level controls: each PATCHes one field and has no
  // form of its own, so a rejection has nowhere to go but a toast.
  function patchUser(user: AuthUser, payload: Parameters<typeof updateUser.mutate>[0]["payload"]) {
    updateUser.mutate(
      { id: user.id, payload },
      {
        onError: (err: ApiError) => {
          // The 409 here is the lock-out guard: neither deactivating nor
          // demoting the last active manager is allowed.
          const message = typeof err.detail === "string" ? err.detail : "Could not update this user.";
          showToast(message);
        },
      },
    );
  }

  function handleToggleActive(user: AuthUser) {
    const nextActive = !user.active;
    if (!nextActive && !window.confirm(`Deactivate "${user.name}"? They will be signed out immediately.`)) {
      return;
    }
    patchUser(user, { active: nextActive });
  }

  function handleAccessLevelChange(user: AuthUser, level: AccessLevel) {
    if (level === user.access_level) {
      return;
    }
    patchUser(user, { access_level: level });
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
              <th className="py-1 pr-4 font-medium">Access level</th>
              <th className="py-1 pr-4 font-medium">Linked to</th>
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
                <td className="py-1 pr-4">
                  <select
                    aria-label={`Access level for ${u.name}`}
                    value={u.access_level}
                    disabled={updateUser.isPending}
                    onChange={(e) => handleAccessLevelChange(u, e.target.value as AccessLevel)}
                    className="rounded border border-border p-1 text-xs disabled:opacity-50"
                  >
                    {ACCESS_LEVELS.map((level) => (
                      <option key={level} value={level}>
                        {accessLevelLabel(level)}
                      </option>
                    ))}
                  </select>
                </td>
                <td className="py-1 pr-4">{linkedLabel(u)}</td>
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
