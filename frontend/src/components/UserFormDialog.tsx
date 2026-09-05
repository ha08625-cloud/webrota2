import * as Dialog from "@radix-ui/react-dialog";
import { useState } from "react";
import type { FormEvent } from "react";

import { useDoctors } from "@/api/doctors";
import { useReceptionStaff } from "@/api/reception";
import { useCreateUser, useUpdateUser, useUsers } from "@/api/users";
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

interface StaffOption {
  id: number;
  label: string;
}

/**
 * The staff rows this user may be linked to: everything not already
 * claimed by *another* user, plus - always - this user's own current
 * link, so an existing link renders its own value rather than silently
 * falling back to "Not linked".
 *
 * Inactive rows are included for the same reason and suffixed, because a
 * link to a soft-deleted doctor is a supported state, not a mistake to
 * hide (staff linking, D4).
 */
function staffOptions(
  staff: readonly { id: number; code: string; active: boolean }[] | undefined,
  claimedByOthers: ReadonlySet<number>,
  currentId: number | "",
): StaffOption[] {
  return (staff ?? [])
    .filter((s) => s.id === currentId || !claimedByOthers.has(s.id))
    .map((s) => ({ id: s.id, label: s.active ? s.code : `${s.code} (inactive)` }));
}

export function UserFormDialog({ user, open, onOpenChange }: UserFormDialogProps) {
  const createUser = useCreateUser();
  const updateUser = useUpdateUser();
  // Inactive included in both: see staffOptions. `useUsers()` is already
  // fetched by the page that renders this dialog, so reading it here to
  // work out which staff rows are taken costs no extra request.
  const { data: doctors } = useDoctors(false);
  const { data: receptionStaff } = useReceptionStaff(true);
  const { data: users } = useUsers();

  const [values, setValues] = useState<UserFormValues>(() =>
    user ? formValuesFromUser(user) : emptyFormValues(),
  );
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);

  const isSaving = createUser.isPending || updateUser.isPending;
  const mode = user ? "edit" : "create";

  const otherUsers = (users ?? []).filter((u) => u.id !== user?.id);
  const doctorOptions = staffOptions(
    doctors,
    new Set(otherUsers.flatMap((u) => (u.linked_doctor ? [u.linked_doctor.id] : []))),
    values.doctor_id,
  );
  const receptionOptions = staffOptions(
    receptionStaff,
    new Set(otherUsers.flatMap((u) => (u.linked_reception_staff ? [u.linked_reception_staff.id] : []))),
    values.reception_staff_id,
  );

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
                  failure. */}
              {fieldErrors.access_level ? (
                <p className="mt-1 text-xs text-red-700">{fieldErrors.access_level}</p>
              ) : null}
            </div>

            {/* Identity, not permission: this is what makes "my rota" and
                the calendar page know who you are, and it is deliberately
                independent of the access level above (staff linking, D3).
                Neither handler touches access_level. */}
            <div>
              <label className="block text-sm font-medium" htmlFor="user-doctor-id">
                Linked doctor
              </label>
              <select
                id="user-doctor-id"
                value={values.doctor_id}
                onChange={(e) =>
                  setValues((v) => ({
                    ...v,
                    doctor_id: e.target.value === "" ? "" : Number(e.target.value),
                  }))
                }
                className="mt-1 w-full rounded border border-border p-1 text-sm"
              >
                <option value="">Not linked</option>
                {doctorOptions.map((option) => (
                  <option key={option.id} value={option.id}>
                    {option.label}
                  </option>
                ))}
              </select>
            </div>

            <div>
              <label className="block text-sm font-medium" htmlFor="user-reception-staff-id">
                Linked reception staff
              </label>
              <select
                id="user-reception-staff-id"
                value={values.reception_staff_id}
                onChange={(e) =>
                  setValues((v) => ({
                    ...v,
                    reception_staff_id: e.target.value === "" ? "" : Number(e.target.value),
                  }))
                }
                className="mt-1 w-full rounded border border-border p-1 text-sm"
              >
                <option value="">Not linked</option>
                {receptionOptions.map((option) => (
                  <option key={option.id} value={option.id}>
                    {option.label}
                  </option>
                ))}
              </select>
              <p className="mt-1 text-xs text-ink/50">
                Linking tells the app which rota entries are this person's own - it is separate from
                their access level. Staff already linked to another user are not listed.
              </p>
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