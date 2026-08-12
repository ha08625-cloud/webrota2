import * as Dialog from "@radix-ui/react-dialog";
import { useState } from "react";
import type { FormEvent } from "react";

import { useCreateUser, useUpdateUser } from "@/api/users";
import type { AccessLevel, ApiError, AuthUser } from "@/api/types";
import { ACCESS_LEVELS, accessLevelDescription, accessLevelLabel } from "@/lib/accessLevels";
import {
  type UserFormValues,
  emptyFormValues,
  formValuesFromUser,
  mapZodFieldErrors,
  toCreatePayload,
  toPatchPayload,
  userFormSchema,
} from "@/lib/userSchema";

interface UserFormDialogProps {
  /** undefined = create mode. Render with a `key` on the user's id (or
   * "new") from the parent, so switching which record is being edited
   * remounts this component and its form state resets cleanly - same
   * convention as DoctorFormDialog. */
  user?: AuthUser;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function UserFormDialog({ user, open, onOpenChange }: UserFormDialogProps) {
  const createUser = useCreateUser();
  const updateUser = useUpdateUser();

  const [values, setValues] = useState<UserFormValues>(() =>
    user ? formValuesFromUser(user) : emptyFormValues(),
  );
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);

  const isSaving = createUser.isPending || updateUser.isPending;
  const mode = user ? "edit" : "create";

  function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setFieldErrors({});
    setFormError(null);

    const result = userFormSchema(mode).safeParse(values);
    if (!result.success) {
      setFieldErrors(mapZodFieldErrors(result.error));
      return;
    }

    const onError = (err: ApiError) => {
      setFormError(typeof err.detail === "string" ? err.detail : "Could not save this user.");
    };

    if (!user) {
      createUser.mutate(toCreatePayload(result.data), {
        onSuccess: () => onOpenChange(false),
        onError,
      });
      return;
    }

    updateUser.mutate(
      { id: user.id, payload: toPatchPayload(result.data) },
      { onSuccess: () => onOpenChange(false), onError },
    );
  }

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 bg-ink/30" />
        <Dialog.Content className="fixed left-1/2 top-1/2 w-96 -translate-x-1/2 -translate-y-1/2 rounded bg-surface p-5 shadow-lg">
          <Dialog.Title className="text-lg font-semibold">{user ? `Edit ${user.name}` : "New User"}</Dialog.Title>

          <form onSubmit={handleSubmit} className="mt-4 space-y-4">
            {formError ? <p className="rounded bg-red-50 p-2 text-sm text-red-700">{formError}</p> : null}

            <div>
              <label className="block text-sm font-medium" htmlFor="user-email">
                Email
              </label>
              <input
                id="user-email"
                type="email"
                value={values.email}
                onChange={(e) => setValues((v) => ({ ...v, email: e.target.value }))}
                className="mt-1 w-full rounded border border-border p-1 text-sm"
              />
              {fieldErrors.email ? <p className="mt-1 text-xs text-red-700">{fieldErrors.email}</p> : null}
            </div>

            <div>
              <label className="block text-sm font-medium" htmlFor="user-name">
                Name
              </label>
              <input
                id="user-name"
                type="text"
                value={values.name}
                onChange={(e) => setValues((v) => ({ ...v, name: e.target.value }))}
                className="mt-1 w-full rounded border border-border p-1 text-sm"
              />
              {fieldErrors.name ? <p className="mt-1 text-xs text-red-700">{fieldErrors.name}</p> : null}
            </div>

            <div>
              <label className="block text-sm font-medium" htmlFor="user-access-level">
                Access level
              </label>
              <select
                id="user-access-level"
                value={values.access_level}
                onChange={(e) =>
                  setValues((v) => ({ ...v, access_level: e.target.value as AccessLevel }))
                }
                className="mt-1 w-full rounded border border-border p-1 text-sm"
              >
                {ACCESS_LEVELS.map((level) => (
                  <option key={level} value={level}>
                    {accessLevelLabel(level)} - {accessLevelDescription(level)}
                  </option>
                ))}
              </select>
              {/* Demoting the last active manager is a 409 from the
                  server, surfaced as formError like any other save
                  failure (role-based auth, Design Decision 5). */}
              {fieldErrors.access_level ? (
                <p className="mt-1 text-xs text-red-700">{fieldErrors.access_level}</p>
              ) : null}
            </div>

            <div>
              <label className="block text-sm font-medium" htmlFor="user-password">
                {user ? "New password" : "Password"}
              </label>
              <input
                id="user-password"
                type="password"
                value={values.password}
                onChange={(e) => setValues((v) => ({ ...v, password: e.target.value }))}
                className="mt-1 w-full rounded border border-border p-1 text-sm"
              />
              {user ? <p className="mt-1 text-xs text-ink/50">Leave blank to keep the current password.</p> : null}
              {fieldErrors.password ? (
                <p className="mt-1 text-xs text-red-700">{fieldErrors.password}</p>
              ) : null}
            </div>

            <div className="flex justify-end gap-2 border-t border-border pt-3">
              <Dialog.Close className="rounded px-3 py-1 text-sm text-ink/70">Cancel</Dialog.Close>
              <button
                type="submit"
                disabled={isSaving}
                className="rounded bg-accent px-4 py-1 text-sm font-medium text-white disabled:opacity-50"
              >
                Save
              </button>
            </div>
          </form>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}