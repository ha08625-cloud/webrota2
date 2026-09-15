import * as Dialog from "@radix-ui/react-dialog";
import { useState } from "react";
import type { FormEvent } from "react";

import { useUsers } from "@/api/users";
import type { ApiError } from "@/api/types";
import { useCanAdminUsers } from "@/auth/AuthContext";

import { useCreateStudy, useUpdateStudy } from "./api";
import {
  emptyContact,
  emptyStudyForm,
  studyFieldErrors,
  studyFormSchema,
  studyFormValues,
  toStudyPayload,
} from "./studySchema";
import type { StudyFormValues } from "./studySchema";
import type { Study } from "./types";

/**
 * Create and edit the persistent study header, contacts included.
 *
 * The contacts rows are edited here rather than through endpoints of
 * their own because the API has none: a study PATCH carrying `contacts`
 * is a full replace. So the dialog always sends the whole
 * list, and a row removed here is a row deleted on save.
 *
 * Stage is not editable from this dialog, deliberately - it is the study
 * page's advance/revert controls and nothing else, so that a form submit
 * can never move a study.
 */

interface StudyFormDialogProps {
  /** undefined = create mode. Parents render with a `key` on the study id
   * (or "new") so switching subject remounts, matching the app's other
   * form dialogs. */
  study?: Study;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Called with the created study, so the list page can navigate to it. */
  onCreated?: (study: Study) => void;
}

function extractErrorMessage(err: unknown): string {
  const detail = (err as ApiError | undefined)?.detail;
  return typeof detail === "string" ? detail : "Could not save this study.";
}

const inputClass = "mt-1 w-full rounded border border-border p-1 text-sm";

/**
 * Its own component because `useUsers` has no `enabled` switch and the
 * whole list is manager-only: a research-only login would 403 on it. That
 * login keeps whatever owner the study has - the value round-trips
 * untouched - and sees the name the server denormalised onto the study.
 */
function OwnerSelect({
  value,
  onChange,
}: {
  value: number | null;
  onChange: (value: number | null) => void;
}) {
  const { data: users } = useUsers();

  return (
    <select
      id="study-owner"
      value={value ?? ""}
      onChange={(event) => onChange(event.target.value === "" ? null : Number(event.target.value))}
      className={inputClass}
    >
      <option value="">No owner</option>
      {(users ?? []).map((user) => (
        <option key={user.id} value={user.id}>
          {user.name}
        </option>
      ))}
    </select>
  );
}

export function StudyFormDialog({ study, open, onOpenChange, onCreated }: StudyFormDialogProps) {
  const createStudy = useCreateStudy();
  const updateStudy = useUpdateStudy();
  const canPickOwner = useCanAdminUsers();

  const [values, setValues] = useState<StudyFormValues>(() =>
    study ? studyFormValues(study) : emptyStudyForm(),
  );
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);

  const isSaving = createStudy.isPending || updateStudy.isPending;

  function setField<K extends keyof StudyFormValues>(key: K, value: StudyFormValues[K]) {
    setValues((current) => ({ ...current, [key]: value }));
  }

  function setContactField(index: number, key: "name" | "role" | "email" | "phone", value: string) {
    setValues((current) => ({
      ...current,
      contacts: current.contacts.map((contact, i) =>
        i === index ? { ...contact, [key]: value } : contact,
      ),
    }));
  }

  function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setError(null);

    const parsed = studyFormSchema.safeParse(values);
    if (!parsed.success) {
      setFieldErrors(studyFieldErrors(parsed.error));
      return;
    }
    setFieldErrors({});

    const payload = toStudyPayload(parsed.data);

    if (!study) {
      createStudy.mutate(payload, {
        onSuccess: (created) => {
          onOpenChange(false);
          onCreated?.(created);
        },
        onError: (err) => setError(extractErrorMessage(err)),
      });
      return;
    }

    updateStudy.mutate(
      { studyId: study.id, payload },
      {
        onSuccess: () => onOpenChange(false),
        onError: (err) => setError(extractErrorMessage(err)),
      },
    );
  }

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 bg-ink/30" />
        <Dialog.Content className="fixed left-1/2 top-1/2 max-h-[90vh] w-[32rem] -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded bg-surface p-5 shadow-lg">
          <Dialog.Title className="text-lg font-semibold">
            {study ? `Edit ${study.name}` : "New study"}
          </Dialog.Title>

          <form onSubmit={handleSubmit} className="mt-4 space-y-4">
            {error ? <p className="rounded bg-red-50 p-2 text-sm text-red-700">{error}</p> : null}

            <div>
              <label className="block text-sm font-medium" htmlFor="study-name">
                Name
              </label>
              <input
                id="study-name"
                type="text"
                value={values.name}
                onChange={(e) => setField("name", e.target.value)}
                className={inputClass}
              />
              {fieldErrors.name ? (
                <p className="mt-1 text-xs text-red-700">{fieldErrors.name}</p>
              ) : null}
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-sm font-medium" htmlFor="study-cpms-code">
                  CPMS code
                </label>
                <input
                  id="study-cpms-code"
                  type="text"
                  value={values.cpmsCode}
                  onChange={(e) => setField("cpmsCode", e.target.value)}
                  className={inputClass}
                />
              </div>
              <div>
                <label className="block text-sm font-medium" htmlFor="study-type">
                  Study type
                </label>
                <input
                  id="study-type"
                  type="text"
                  value={values.studyType}
                  onChange={(e) => setField("studyType", e.target.value)}
                  placeholder="e.g. Interventional"
                  className={inputClass}
                />
              </div>
            </div>

            <div>
              <label className="block text-sm font-medium" htmlFor="study-website">
                Study website
              </label>
              <input
                id="study-website"
                type="text"
                value={values.websiteUrl}
                onChange={(e) => setField("websiteUrl", e.target.value)}
                placeholder="https://..."
                className={inputClass}
              />
              {fieldErrors.websiteUrl ? (
                <p className="mt-1 text-xs text-red-700">{fieldErrors.websiteUrl}</p>
              ) : null}
            </div>

            <div>
              <label className="block text-sm font-medium" htmlFor="study-owner">
                Owner
              </label>
              {canPickOwner ? (
                <OwnerSelect
                  value={values.ownerUserId}
                  onChange={(value) => setField("ownerUserId", value)}
                />
              ) : (
                <p className="mt-1 text-sm text-ink/70">
                  {study?.owner_name ?? "No owner"}
                  <span className="block text-xs text-ink/50">
                    Only a user administrator can change the owner.
                  </span>
                </p>
              )}
            </div>

            <fieldset className="border-t border-border pt-3">
              <legend className="text-sm font-medium">Contacts</legend>
              <p className="text-xs text-ink/50">
                Who to ring about this study. Saving replaces the whole list.
              </p>

              {values.contacts.length === 0 ? (
                <p className="mt-2 text-sm text-ink/50">No contacts.</p>
              ) : null}

              <ul className="mt-2 space-y-3">
                {values.contacts.map((contact, index) => (
                  <li key={index} className="rounded border border-border p-2">
                    <div className="grid grid-cols-2 gap-2">
                      <div>
                        <label className="block text-xs text-ink/70" htmlFor={`contact-name-${index}`}>
                          Name
                        </label>
                        <input
                          id={`contact-name-${index}`}
                          type="text"
                          value={contact.name}
                          onChange={(e) => setContactField(index, "name", e.target.value)}
                          className={inputClass}
                        />
                        {fieldErrors[`contacts.${index}.name`] ? (
                          <p className="mt-1 text-xs text-red-700">
                            {fieldErrors[`contacts.${index}.name`]}
                          </p>
                        ) : null}
                      </div>
                      <div>
                        <label className="block text-xs text-ink/70" htmlFor={`contact-role-${index}`}>
                          Role
                        </label>
                        <input
                          id={`contact-role-${index}`}
                          type="text"
                          value={contact.role}
                          onChange={(e) => setContactField(index, "role", e.target.value)}
                          className={inputClass}
                        />
                      </div>
                      <div>
                        <label className="block text-xs text-ink/70" htmlFor={`contact-email-${index}`}>
                          Email
                        </label>
                        <input
                          id={`contact-email-${index}`}
                          type="text"
                          value={contact.email}
                          onChange={(e) => setContactField(index, "email", e.target.value)}
                          className={inputClass}
                        />
                      </div>
                      <div>
                        <label className="block text-xs text-ink/70" htmlFor={`contact-phone-${index}`}>
                          Phone
                        </label>
                        <input
                          id={`contact-phone-${index}`}
                          type="text"
                          value={contact.phone}
                          onChange={(e) => setContactField(index, "phone", e.target.value)}
                          className={inputClass}
                        />
                      </div>
                    </div>
                    <button
                      type="button"
                      onClick={() =>
                        setValues((current) => ({
                          ...current,
                          contacts: current.contacts.filter((_, i) => i !== index),
                        }))
                      }
                      className="mt-2 text-xs text-red-700"
                    >
                      Remove contact
                    </button>
                  </li>
                ))}
              </ul>

              <button
                type="button"
                onClick={() =>
                  setValues((current) => ({
                    ...current,
                    contacts: [...current.contacts, emptyContact()],
                  }))
                }
                className="mt-2 text-xs text-accent"
              >
                Add contact
              </button>
            </fieldset>

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
