import * as Dialog from "@radix-ui/react-dialog";
import { useState } from "react";
import type { FormEvent } from "react";

import {
  useCreateRecurringNote,
  useDeleteRecurringNote,
  useRecurringNotes,
  useUpdateRecurringNote,
} from "@/api/recurringNotes";
import { useDoctors } from "@/api/doctors";
import type { Day, Doctor, DoctorType, Period, RecurringNote, RecurringNoteIn } from "@/api/types";
import { useWriteGate } from "@/auth/AuthContext";

const DAYS: Day[] = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday"];
const PERIODS: Period[] = ["AM", "PM"];

const DAY_ORDER: Record<Day, number> = {
  Monday: 0,
  Tuesday: 1,
  Wednesday: 2,
  Thursday: 3,
  Friday: 4,
};

const PERIOD_ORDER: Record<Period, number> = { AM: 0, PM: 1 };

/**
 * Bulk-select shortcuts for the default-doctor picker. These are the only
 * groupings offered: "All doctors" deliberately means the three doctor
 * grades and excludes Locum and AHP. Each box is a pure shortcut over the
 * individual ticks below it - nothing about the group is stored, the note
 * still holds a plain list of doctor ids, so a doctor added later is not
 * retrospectively part of any meeting.
 */
const DOCTOR_GROUPS: { label: string; types: DoctorType[] }[] = [
  { label: "All doctors", types: ["Partner", "Salaried", "Trainee"] },
  { label: "All partners", types: ["Partner"] },
  { label: "All salaried doctors", types: ["Salaried"] },
  { label: "All trainees", types: ["Trainee"] },
];

function formatDoctors(doctorIds: number[], doctorsById: Map<number, Doctor>): string {
  return doctorIds
    .map((id) => doctorsById.get(id)?.code ?? `Doctor ${id}`)
    .sort()
    .join(", ");
}

interface DialogState {
  open: boolean;
  note?: RecurringNote;
}

interface RecurringNoteFormDialogProps {
  note?: RecurringNote;
  activeDoctors: Doctor[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

function RecurringNoteFormDialog({ note, activeDoctors, open, onOpenChange }: RecurringNoteFormDialogProps) {
  const writeGate = useWriteGate();
  const createNote = useCreateRecurringNote();
  const updateNote = useUpdateRecurringNote();

  const [text, setText] = useState(note?.text ?? "");
  const [day, setDay] = useState<Day>(note?.day ?? "Monday");
  const [period, setPeriod] = useState<Period>(note?.period ?? "AM");
  const [doctorIds, setDoctorIds] = useState<number[]>(note?.doctor_ids ?? []);
  const [isActive, setIsActive] = useState(note?.is_active ?? true);
  const [formError, setFormError] = useState<string | null>(null);

  const isSaving = createNote.isPending || updateNote.isPending;
  const canSave = text.trim().length > 0;

  function toggleDoctor(id: number) {
    setDoctorIds((prev) => (prev.includes(id) ? prev.filter((d) => d !== id) : [...prev, id]));
  }

  const groups = DOCTOR_GROUPS.map((group) => ({
    label: group.label,
    ids: activeDoctors.filter((d) => group.types.includes(d.doctor_type)).map((d) => d.id),
  })).filter((group) => group.ids.length > 0);

  function toggleGroup(ids: number[], checked: boolean) {
    setDoctorIds((prev) =>
      checked
        ? [...prev, ...ids.filter((id) => !prev.includes(id))]
        : prev.filter((id) => !ids.includes(id)),
    );
  }

  function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setFormError(null);
    if (!canSave) return;

    const payload: RecurringNoteIn = {
      text: text.trim(),
      day,
      period,
      is_active: isActive,
      doctor_ids: doctorIds,
    };
    const onError = (err: { status: number; detail: unknown }) => {
      setFormError(typeof err.detail === "string" ? err.detail : "Could not save this meeting.");
    };

    if (note) {
      updateNote.mutate({ id: note.id, payload }, { onSuccess: () => onOpenChange(false), onError });
    } else {
      createNote.mutate(payload, { onSuccess: () => onOpenChange(false), onError });
    }
  }

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 bg-ink/30" />
        <Dialog.Content className="fixed left-1/2 top-1/2 max-h-[90vh] w-[30rem] -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded bg-surface p-5 shadow-lg">
          <Dialog.Title className="text-lg font-semibold">
            {note ? "Edit Meeting" : "New Meeting"}
          </Dialog.Title>

          <form onSubmit={handleSubmit} className="mt-4 space-y-4">
            {formError ? <p className="rounded bg-red-50 p-2 text-sm text-red-700">{formError}</p> : null}

            <div>
              <label className="block text-sm font-medium" htmlFor="rn-text">
                Text
              </label>
              <input
                id="rn-text"
                type="text"
                maxLength={200}
                value={text}
                onChange={(e) => setText(e.target.value)}
                className="mt-1 w-full rounded border border-border p-1 text-sm"
              />
            </div>

            <div className="flex gap-4">
              <div>
                <label className="block text-sm font-medium" htmlFor="rn-day">
                  Default day
                </label>
                <select
                  id="rn-day"
                  value={day}
                  onChange={(e) => setDay(e.target.value as Day)}
                  className="mt-1 rounded border border-border p-1 text-sm"
                >
                  {DAYS.map((d) => (
                    <option key={d} value={d}>
                      {d}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-sm font-medium" htmlFor="rn-period">
                  Default period
                </label>
                <select
                  id="rn-period"
                  value={period}
                  onChange={(e) => setPeriod(e.target.value as Period)}
                  className="mt-1 rounded border border-border p-1 text-sm"
                >
                  {PERIODS.map((p) => (
                    <option key={p} value={p}>
                      {p}
                    </option>
                  ))}
                </select>
              </div>
            </div>

            <fieldset>
              <legend className="text-sm font-medium">Default doctors</legend>
              {groups.length > 0 ? (
                <ul className="mt-1 space-y-1 border-b border-border pb-2" aria-label="Doctor groups">
                  {groups.map((group) => (
                    <li key={group.label}>
                      <label className="flex items-center gap-2 text-sm">
                        <input
                          type="checkbox"
                          checked={group.ids.every((id) => doctorIds.includes(id))}
                          onChange={(e) => toggleGroup(group.ids, e.target.checked)}
                        />
                        {group.label}
                      </label>
                    </li>
                  ))}
                </ul>
              ) : null}
              <ul className="mt-2 space-y-1" aria-label="Doctors">
                {activeDoctors.map((d) => (
                  <li key={d.id}>
                    <label className="flex items-center gap-2 text-sm">
                      <input
                        type="checkbox"
                        checked={doctorIds.includes(d.id)}
                        onChange={() => toggleDoctor(d.id)}
                      />
                      {d.code}
                    </label>
                  </li>
                ))}
              </ul>
            </fieldset>

            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={isActive} onChange={(e) => setIsActive(e.target.checked)} />
              Active
            </label>

            <div className="flex justify-end gap-2 border-t border-border pt-3">
              <Dialog.Close className="rounded px-3 py-1 text-sm text-ink/70">Cancel</Dialog.Close>
              <button
                type="submit"
                disabled={isSaving || !canSave}
                className="rounded bg-accent px-4 py-1 text-sm font-medium text-white disabled:opacity-50"
                {...writeGate}
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

export function RecurringNotesPage() {
  const writeGate = useWriteGate();
  const { data: notes, isLoading, isError } = useRecurringNotes();
  const { data: doctors } = useDoctors(true);
  const deleteNote = useDeleteRecurringNote();

  const [dialogState, setDialogState] = useState<DialogState>({ open: false });
  const [deleteError, setDeleteError] = useState<string | null>(null);

  const activeDoctors = doctors ?? [];
  const doctorsById = new Map(activeDoctors.map((d) => [d.id, d]));

  const sortedNotes = (notes ?? [])
    .slice()
    .sort((a, b) => DAY_ORDER[a.day] - DAY_ORDER[b.day] || PERIOD_ORDER[a.period] - PERIOD_ORDER[b.period]);

  function openCreate() {
    setDeleteError(null);
    setDialogState({ open: true, note: undefined });
  }

  function openEdit(note: RecurringNote) {
    setDeleteError(null);
    setDialogState({ open: true, note });
  }

  function handleDelete(note: RecurringNote) {
    if (
      !window.confirm(
        `Delete meeting "${note.text}"? Rotas that already picked it keep their copy. This cannot be undone.`,
      )
    ) {
      return;
    }
    setDeleteError(null);
    deleteNote.mutate(note.id, {
      onError: (err) => {
        setDeleteError(typeof err.detail === "string" ? err.detail : "Could not delete this meeting.");
      },
    });
  }

  return (
    <div>
      <div className="flex items-center justify-between">
        <h1 className="text-lg font-semibold">Meetings</h1>
        <button
          type="button"
          onClick={openCreate}
          className="rounded bg-accent px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
          {...writeGate}
        >
          New Meeting
        </button>
      </div>
      <p className="mt-1 text-sm text-ink/70">
        A library of meetings with a default day, period and doctors. Nothing here is scheduled: a meeting
        appears on a rota only when you tick it on the staging page for that run, which copies these defaults
        onto that rota and lets you change them for that run alone.
      </p>
      <p className="mt-1 text-sm text-ink/70">
        Annotation only - a meeting has no effect on availability, eligibility or duty.
      </p>

      {deleteError ? <p className="mt-3 text-sm text-red-700">{deleteError}</p> : null}

      {isLoading ? <p className="mt-4 text-sm text-ink/70">Loading...</p> : null}
      {isError ? <p className="mt-4 text-sm text-red-700">Could not load meetings.</p> : null}

      {notes && notes.length === 0 ? <p className="mt-4 text-sm text-ink/50">No meetings.</p> : null}

      {notes && notes.length > 0 ? (
        <table className="mt-4 min-w-full text-sm">
          <thead>
            <tr className="text-left text-ink/70">
              <th className="py-1 pr-4 font-medium">Default day</th>
              <th className="py-1 pr-4 font-medium">Default period</th>
              <th className="py-1 pr-4 font-medium">Text</th>
              <th className="py-1 pr-4 font-medium">Default doctors</th>
              <th className="py-1 pr-4 font-medium">Active</th>
              <th className="py-1" />
            </tr>
          </thead>
          <tbody>
            {sortedNotes.map((n) => (
              <tr key={n.id} className="border-t border-border">
                <td className="py-1 pr-4">{n.day}</td>
                <td className="py-1 pr-4">{n.period}</td>
                <td className="py-1 pr-4">{n.text}</td>
                <td className="py-1 pr-4">{formatDoctors(n.doctor_ids, doctorsById)}</td>
                <td className="py-1 pr-4">{n.is_active ? "Yes" : "No"}</td>
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
                    onClick={() => handleDelete(n)}
                    className="text-xs text-red-700 disabled:opacity-50"
                    {...writeGate}
                  >
                    Delete
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}

      {dialogState.open ? (
        <RecurringNoteFormDialog
          key={dialogState.note?.id ?? "new"}
          note={dialogState.note}
          activeDoctors={activeDoctors}
          open={dialogState.open}
          onOpenChange={(open) => setDialogState((s) => ({ ...s, open }))}
        />
      ) : null}
    </div>
  );
}
