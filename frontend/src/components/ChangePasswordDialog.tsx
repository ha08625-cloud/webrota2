import * as Dialog from "@radix-ui/react-dialog";
import { useState, type FormEvent } from "react";

import { triggerUnauthorized } from "@/api/client";
import type { ApiError } from "@/api/types";
import { useUpdateSelf } from "@/api/users";
import { clearToken } from "@/auth/tokenStore";
import { passwordRule } from "@/lib/userSchema";

/**
 * Self-service password change, in the app header of every shell
 * (role-based auth, Task 3).
 *
 * This exists because /users is manager-only: without it a doctor or
 * nurse would have to ask a manager to reset their password, and that
 * reset signs them out anyway. It posts to PATCH /users/me, which also
 * accepts `name`; the UI does not offer that, since nothing in the app
 * displays your own name and a silent rename would just leave the auth
 * context stale.
 *
 * On success it signs the user out on purpose. The backend deletes every
 * session belonging to the user when the password changes - including the
 * one making the request - so the very next call would 401 with no
 * explanation. Clearing the token and broadcasting a *reason* gets the
 * login form up with "your password was changed" instead of an
 * unexplained bounce (Task 3 instruction 6).
 */
const SIGNED_OUT_MESSAGE = "Your password was changed. Please log in again with your new password.";

export function ChangePasswordDialog() {
  const [open, setOpen] = useState(false);

  return (
    <Dialog.Root open={open} onOpenChange={setOpen}>
      <Dialog.Trigger className="text-sm text-ink/80 hover:text-accent">Change password</Dialog.Trigger>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 bg-ink/30" />
        <Dialog.Content className="fixed left-1/2 top-1/2 w-96 -translate-x-1/2 -translate-y-1/2 rounded bg-surface p-5 shadow-lg">
          {/* Keyed on `open` so the form state resets between openings -
              same remount convention as the *FormDialog components. */}
          <ChangePasswordForm key={String(open)} onCancel={() => setOpen(false)} />
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function ChangePasswordForm({ onCancel }: { onCancel: () => void }) {
  const updateSelf = useUpdateSelf();
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);

  function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setError(null);

    const parsed = passwordRule.safeParse(password);
    if (!parsed.success) {
      setError(parsed.error.issues[0].message);
      return;
    }
    if (password !== confirm) {
      setError("The two passwords do not match.");
      return;
    }

    updateSelf.mutate(
      { password },
      {
        onSuccess: () => {
          clearToken();
          triggerUnauthorized(SIGNED_OUT_MESSAGE);
        },
        onError: (err: ApiError) => {
          setError(typeof err.detail === "string" ? err.detail : "Could not change your password.");
        },
      },
    );
  }

  return (
    <>
      <Dialog.Title className="text-lg font-semibold">Change password</Dialog.Title>
      <Dialog.Description className="mt-1 text-sm text-ink/70">
        Changing your password signs you out everywhere, including here.
      </Dialog.Description>

      <form onSubmit={handleSubmit} className="mt-4 space-y-4">
        {error ? <p className="rounded bg-red-50 p-2 text-sm text-red-700">{error}</p> : null}

        <div>
          <label className="block text-sm font-medium" htmlFor="self-password">
            New password
          </label>
          <input
            id="self-password"
            type="password"
            autoComplete="new-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="mt-1 w-full rounded border border-border p-1 text-sm"
          />
        </div>

        <div>
          <label className="block text-sm font-medium" htmlFor="self-password-confirm">
            Confirm new password
          </label>
          <input
            id="self-password-confirm"
            type="password"
            autoComplete="new-password"
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            className="mt-1 w-full rounded border border-border p-1 text-sm"
          />
        </div>

        <div className="flex justify-end gap-2 border-t border-border pt-3">
          <button type="button" onClick={onCancel} className="rounded px-3 py-1 text-sm text-ink/70">
            Cancel
          </button>
          <button
            type="submit"
            disabled={updateSelf.isPending}
            className="rounded bg-accent px-4 py-1 text-sm font-medium text-white disabled:opacity-50"
          >
            Save
          </button>
        </div>
      </form>
    </>
  );
}
