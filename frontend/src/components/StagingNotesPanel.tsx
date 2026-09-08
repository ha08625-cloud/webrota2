import * as Dialog from "@radix-ui/react-dialog";
import { useMemo, useState } from "react";
import type { FormEvent } from "react";

import { useDoctors } from "@/api/doctors";
import { useRecurringNotes } from "@/api/recurringNotes";
import {
  useCreateStagingNote,
  useDeleteStagingNote,
  useUpdateStagingNote,
} from "@/api/stagingNotes";
import type {
  Day,
  Doctor,
  Period,
  RecurringNote,
  Staging,
  StagingNote,
  StagingSession,
} from "@/api/types";
import { useWriteGate } from "@/auth/AuthContext";
import { isSlotClosed, toClosedSlotSet } from "@/lib/closedSlots";
import { rotaDate } from "@/lib/weekDates";

const DAYS: Day[] = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday"];
const PERIODS: Period[] = ["AM", "PM"];

/** The editable fields of one instance - the dialog's whole state, and
 * exactly the PATCH body (source_note_id is fixed at pick time). */
interface NoteDraft {
  text: string;
  week: number;
  day: Day;
  period: Period;
  doctorIds: number[];
}

function sameDoctorSet(a: number[], b: number[]): boolean {
  if (a.length !== b.length) return false;
  const setB = new Set(b);
  return a.every((id) => setB.has(id));
}

/**
 * Whether un-ticking a definition needs a confirm (D6). An instance that
 * still matches the definition it was copied from is removed silently;
 * anything the user has since changed for this run is worth a prompt.
 *
 * Several instances count as diverged even when each still matches: the
 * weeks were a per-run choice too, and one click would discard all of
 * them.
 */
export function instancesDiverged(instances: StagingNote[], definition: RecurringNote): boolean {
  if (instances.length > 1) return true;
  const note = instances[0];
  if (!note) return false;
  return (
    note.text !== definition.text ||
    note.day !== definition.day ||
    note.period !== definition.period ||
    !sameDoctorSet(note.doctor_ids, definition.doctor_ids)
  );
}

/**
 * The D5 warning: the slots where Phase 2 will build no SessionSlot, so
 * the note has nothing to land on and vanishes silently.
 *
 * Two of the three suppressors are visible from the staging payload - no
 * staged session for that doctor/week/day/period, and a closed (date,
 * period). The third, a doctor outside their employment window, is not
 * in StagingOut at all and is a known blind spot.
 *
 * Leave is deliberately not a suppressor: Phase 2 still builds the slot
 * with is_on_leave, so a note on a doctor on leave does appear.
 */
export function noteWarnings(
  note: StagingNote,
  sessions: StagingSession[],
  closedSlotSet: Set<string>,
  startDate: string,
  doctorLabel: (id: number) => string,
): string[] {
  const warnings: string[] = [];

  const missing = note.doctor_ids.filter(
    (doctorId) =>
      !sessions.some(
        (s) =>
          s.doctor_id === doctorId &&
          s.week === note.week &&
          s.day === note.day &&
          s.period === note.period,
      ),
  );
  if (missing.length > 0) {
    warnings.push(
      `${missing.map(doctorLabel).join(", ")} ${missing.length === 1 ? "has" : "have"} no ` +
        `${note.day} ${note.period} session in week ${note.week} - this note will not appear for ` +
        `${missing.length === 1 ? "them" : "those doctors"}.`,
    );
  }

  if (isSlotClosed(closedSlotSet, rotaDate(startDate, note.week, note.day), note.period)) {
    warnings.push(
      `Week ${note.week} ${note.day} ${note.period} is closed - this note will not appear.`,
    );
  }

  return warnings;
}

interface NoteFormDialogProps {
  title: string;
  initial: NoteDraft;
  numWeeks: number;
  activeDoctors: Doctor[];
  saving: boolean;
  error: string | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSave: (draft: NoteDraft) => void;
}

/** Shared by "edit this instance" and "add a one-off note" - the two
 * differ only in their initial values and in what the save does. */
function NoteFormDialog({
  title,
  initial,
  numWeeks,
  activeDoctors,
  saving,
  error,
  open,
  onOpenChange,
  onSave,
}: NoteFormDialogProps) {
  const writeGate = useWriteGate();
  const [text, setText] = useState(initial.text);
  const [week, setWeek] = useState(initial.week);
  const [day, setDay] = useState<Day>(initial.day);
  const [period, setPeriod] = useState<Period>(initial.period);
  const [doctorIds, setDoctorIds] = useState<number[]>(initial.doctorIds);

  const canSave = text.trim().length > 0;

  function toggleDoctor(id: number) {
    setDoctorIds((prev) => (prev.includes(id) ? prev.filter((d) => d !== id) : [...prev, id]));
  }

  function handleSubmit(event: FormEvent) {
    event.preventDefault();
    if (!canSave) return;
    onSave({ text: text.trim(), week, day, period, doctorIds });
  }

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 bg-ink/30" />
        <Dialog.Content className="fixed left-1/2 top-1/2 max-h-[90vh] w-[30rem] -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded bg-surface p-5 shadow-lg">
          <Dialog.Title className="text-lg font-semibold">{title}</Dialog.Title>

          <form onSubmit={handleSubmit} className="mt-4 space-y-4">
            {error ? <p className="rounded bg-red-50 p-2 text-sm text-red-700">{error}</p> : null}

            <div>
              <label className="block text-sm font-medium" htmlFor="sn-text">
                Text
              </label>
              <input
                id="sn-text"
                type="text"
                maxLength={200}
                value={text}
                onChange={(e) => setText(e.target.value)}
                className="mt-1 w-full rounded border border-border p-1 text-sm"
              />
            </div>

            <div className="flex gap-4">
              {numWeeks > 1 ? (
                <div>
                  <label className="block text-sm font-medium" htmlFor="sn-week">
                    Week
                  </label>
                  <select
                    id="sn-week"
                    value={week}
                    onChange={(e) => setWeek(Number(e.target.value))}
                    className="mt-1 rounded border border-border p-1 text-sm"
                  >
                    {Array.from({ length: numWeeks }, (_, i) => i + 1).map((w) => (
                      <option key={w} value={w}>
                        Week {w}
                      </option>
                    ))}
                  </select>
                </div>
              ) : null}
              <div>
                <label className="block text-sm font-medium" htmlFor="sn-day">
                  Day
                </label>
                <select
                  id="sn-day"
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
                <label className="block text-sm font-medium" htmlFor="sn-period">
                  Period
                </label>
                <select
                  id="sn-period"
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
              <legend className="text-sm font-medium">Doctors</legend>
              <ul className="mt-1 space-y-1" aria-label="Doctors">
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

            <div className="flex justify-end gap-2 border-t border-border pt-3">
              <Dialog.Close className="rounded px-3 py-1 text-sm text-ink/70">Cancel</Dialog.Close>
              <button
                type="submit"
                disabled={saving || !canSave}
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

interface WeekPickerDialogProps {
  definition: RecurringNote;
  numWeeks: number;
  saving: boolean;
  error: string | null;
  onOpenChange: (open: boolean) => void;
  onConfirm: (weeks: number[]) => void;
}

/** A tick on a multi-week run asks which generation weeks it applies to
 * (D4), defaulting to week 1 only. Each ticked week becomes its own
 * independently editable instance - this is a per-run choice, not a
 * recurrence stored on the definition. */
function WeekPickerDialog({
  definition,
  numWeeks,
  saving,
  error,
  onOpenChange,
  onConfirm,
}: WeekPickerDialogProps) {
  const writeGate = useWriteGate();
  const [weeks, setWeeks] = useState<number[]>([1]);

  function toggleWeek(week: number) {
    setWeeks((prev) => (prev.includes(week) ? prev.filter((w) => w !== week) : [...prev, week]));
  }

  return (
    <Dialog.Root open onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 bg-ink/30" />
        <Dialog.Content className="fixed left-1/2 top-1/2 w-[24rem] -translate-x-1/2 -translate-y-1/2 rounded bg-surface p-5 shadow-lg">
          <Dialog.Title className="text-lg font-semibold">Which weeks?</Dialog.Title>
          <p className="mt-1 text-sm text-ink/70">
            "{definition.text}" will be added to this rota once per week you tick.
          </p>

          {error ? <p className="mt-3 rounded bg-red-50 p-2 text-sm text-red-700">{error}</p> : null}

          <fieldset className="mt-3">
            <legend className="sr-only">Weeks</legend>
            <ul className="space-y-1" aria-label="Weeks">
              {Array.from({ length: numWeeks }, (_, i) => i + 1).map((w) => (
                <li key={w}>
                  <label className="flex items-center gap-2 text-sm">
                    <input type="checkbox" checked={weeks.includes(w)} onChange={() => toggleWeek(w)} />
                    Week {w}
                  </label>
                </li>
              ))}
            </ul>
          </fieldset>

          <div className="mt-4 flex justify-end gap-2 border-t border-border pt-3">
            <Dialog.Close className="rounded px-3 py-1 text-sm text-ink/70">Cancel</Dialog.Close>
            <button
              type="button"
              onClick={() => onConfirm([...weeks].sort((a, b) => a - b))}
              disabled={saving || weeks.length === 0}
              className="rounded bg-accent px-4 py-1 text-sm font-medium text-white disabled:opacity-50"
              {...writeGate}
            >
              Add
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

interface StagingNotesPanelProps {
  staging: Staging;
}

/**
 * The meeting picker for one run. Definitions come from the meetings
 * library (/recurring-notes) and schedule nothing on their own; ticking
 * one *copies* its text, day, period and doctors into a per-run instance
 * on this staging, which can then be edited or deleted for this run
 * alone. Nothing here ever writes back to a definition.
 *
 * Instances live for as long as the staging's RotaConfig does: scrapping
 * the generated draft discards them, exactly as it discards every staged
 * session edit.
 */
export function StagingNotesPanel({ staging }: StagingNotesPanelProps) {
  const writeGate = useWriteGate();
  const { data: definitions } = useRecurringNotes();
  const { data: doctors } = useDoctors(true);
  const createNote = useCreateStagingNote();
  const updateNote = useUpdateStagingNote();
  const deleteNote = useDeleteStagingNote();

  const [weekPickerFor, setWeekPickerFor] = useState<RecurringNote | null>(null);
  const [editing, setEditing] = useState<StagingNote | null>(null);
  const [addingOneOff, setAddingOneOff] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const activeDoctors = doctors ?? [];
  const doctorsById = useMemo(
    () => new Map(activeDoctors.map((d) => [d.id, d])),
    [activeDoctors],
  );
  const doctorLabel = (id: number) => doctorsById.get(id)?.code ?? `Doctor ${id}`;

  const closedSlotSet = useMemo(() => toClosedSlotSet(staging.closed_slots), [staging.closed_slots]);

  const activeDefinitions = (definitions ?? []).filter((d) => d.is_active);
  const definitionsById = new Map((definitions ?? []).map((d) => [d.id, d]));

  function instancesOf(definitionId: number): StagingNote[] {
    return staging.notes.filter((n) => n.source_note_id === definitionId);
  }

  const saving = createNote.isPending || updateNote.isPending || deleteNote.isPending;

  function failWith(message: string) {
    return (err: { status: number; detail: unknown }) => {
      setError(typeof err.detail === "string" ? err.detail : message);
    };
  }

  /** Sequential, not concurrent: each POST returns the whole staging, so
   * two in flight would race and one response would drop the other's
   * note from the cache. */
  async function createForWeeks(definition: RecurringNote, weeks: number[]) {
    setError(null);
    for (const week of weeks) {
      try {
        await createNote.mutateAsync({
          stagingId: staging.staging_id,
          payload: {
            source_note_id: definition.id,
            text: definition.text,
            week,
            day: definition.day,
            period: definition.period,
            doctor_ids: definition.doctor_ids,
          },
        });
      } catch (err) {
        failWith("Could not add this meeting to the rota.")(err as { status: number; detail: unknown });
        return;
      }
    }
    setWeekPickerFor(null);
  }

  function handleTick(definition: RecurringNote) {
    setError(null);
    if (staging.num_weeks > 1) {
      setWeekPickerFor(definition);
      return;
    }
    void createForWeeks(definition, [1]);
  }

  async function handleUntick(definition: RecurringNote) {
    setError(null);
    const instances = instancesOf(definition.id);
    if (instances.length === 0) return;
    if (
      instancesDiverged(instances, definition) &&
      !window.confirm(
        `Remove "${definition.text}" from this rota? The changes made to it for this rota will be lost.`,
      )
    ) {
      return;
    }
    for (const note of instances) {
      try {
        await deleteNote.mutateAsync({ stagingId: staging.staging_id, noteId: note.id });
      } catch (err) {
        failWith("Could not remove this meeting from the rota.")(
          err as { status: number; detail: unknown },
        );
        return;
      }
    }
  }

  function handleDeleteInstance(note: StagingNote) {
    setError(null);
    deleteNote.mutate(
      { stagingId: staging.staging_id, noteId: note.id },
      { onError: failWith("Could not remove this note.") },
    );
  }

  function handleSaveEdit(draft: NoteDraft) {
    if (!editing) return;
    setError(null);
    updateNote.mutate(
      {
        stagingId: staging.staging_id,
        noteId: editing.id,
        payload: {
          text: draft.text,
          week: draft.week,
          day: draft.day,
          period: draft.period,
          doctor_ids: draft.doctorIds,
        },
      },
      { onSuccess: () => setEditing(null), onError: failWith("Could not save this note.") },
    );
  }

  function handleSaveOneOff(draft: NoteDraft) {
    setError(null);
    createNote.mutate(
      {
        stagingId: staging.staging_id,
        payload: {
          source_note_id: null,
          text: draft.text,
          week: draft.week,
          day: draft.day,
          period: draft.period,
          doctor_ids: draft.doctorIds,
        },
      },
      { onSuccess: () => setAddingOneOff(false), onError: failWith("Could not add this note.") },
    );
  }

  return (
    <section className="mt-6 rounded border border-border p-4">
      <div className="flex items-center justify-between">
        <h2 className="text-base font-semibold">Meetings and notes</h2>
        <button
          type="button"
          onClick={() => {
            setError(null);
            setAddingOneOff(true);
          }}
          className="text-sm font-medium text-accent disabled:opacity-50"
          {...writeGate}
        >
          Add a one-off note
        </button>
      </div>
      <p className="mt-1 text-sm text-ink/70">
        Tick the meetings that apply to this rota. Ticking copies the meeting's defaults onto this rota
        only - editing a copy here never changes the meeting itself.
      </p>

      {error ? <p className="mt-3 text-sm text-red-700">{error}</p> : null}

      {activeDefinitions.length === 0 ? (
        <p className="mt-3 text-sm text-ink/50">No meetings are defined.</p>
      ) : (
        <ul className="mt-3 space-y-1" aria-label="Meetings">
          {activeDefinitions.map((definition) => {
            const picked = instancesOf(definition.id).length > 0;
            return (
              <li key={definition.id}>
                <label className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={picked}
                    onChange={() => (picked ? void handleUntick(definition) : handleTick(definition))}
                    {...writeGate}
                  />
                  {definition.text}
                  <span className="text-ink/50">
                    ({definition.day} {definition.period})
                  </span>
                </label>
              </li>
            );
          })}
        </ul>
      )}

      <h3 className="mt-4 text-sm font-semibold">On this rota</h3>
      {staging.notes.length === 0 ? (
        <p className="mt-1 text-sm text-ink/50">No notes on this rota.</p>
      ) : (
        <ul className="mt-1 space-y-2" aria-label="Notes on this rota">
          {staging.notes.map((note) => {
            const source =
              note.source_note_id === null ? null : definitionsById.get(note.source_note_id) ?? null;
            const warnings = noteWarnings(
              note,
              staging.sessions,
              closedSlotSet,
              staging.start_date,
              doctorLabel,
            );
            return (
              <li key={note.id} className="border-t border-border pt-2 text-sm">
                <div className="flex items-start justify-between gap-4">
                  <div>
                    <span className="font-medium">{note.text}</span>{" "}
                    <span className="text-ink/70">
                      {staging.num_weeks > 1 ? `Week ${note.week}, ` : ""}
                      {note.day} {note.period}
                      {note.doctor_ids.length > 0
                        ? ` - ${note.doctor_ids.map(doctorLabel).sort().join(", ")}`
                        : " - no doctors"}
                    </span>
                    {source ? (
                      <span className="ml-2 text-xs text-ink/50">from: {source.text}</span>
                    ) : null}
                  </div>
                  <div className="shrink-0">
                    <button
                      type="button"
                      onClick={() => {
                        setError(null);
                        setEditing(note);
                      }}
                      className="mr-3 text-xs text-accent disabled:opacity-50"
                      {...writeGate}
                    >
                      Edit
                    </button>
                    <button
                      type="button"
                      onClick={() => handleDeleteInstance(note)}
                      className="text-xs text-red-700 disabled:opacity-50"
                      {...writeGate}
                    >
                      Remove
                    </button>
                  </div>
                </div>
                {warnings.map((warning) => (
                  <p key={warning} className="mt-1 text-xs text-amber-700">
                    {warning}
                  </p>
                ))}
              </li>
            );
          })}
        </ul>
      )}

      {weekPickerFor ? (
        <WeekPickerDialog
          key={weekPickerFor.id}
          definition={weekPickerFor}
          numWeeks={staging.num_weeks}
          saving={saving}
          error={error}
          onOpenChange={(open) => {
            if (!open) setWeekPickerFor(null);
          }}
          onConfirm={(weeks) => void createForWeeks(weekPickerFor, weeks)}
        />
      ) : null}

      {editing ? (
        <NoteFormDialog
          key={`edit-${editing.id}`}
          title="Edit note"
          initial={{
            text: editing.text,
            week: editing.week,
            day: editing.day,
            period: editing.period,
            doctorIds: editing.doctor_ids,
          }}
          numWeeks={staging.num_weeks}
          activeDoctors={activeDoctors}
          saving={saving}
          error={error}
          open
          onOpenChange={(open) => {
            if (!open) setEditing(null);
          }}
          onSave={handleSaveEdit}
        />
      ) : null}

      {addingOneOff ? (
        <NoteFormDialog
          key="one-off"
          title="Add a one-off note"
          initial={{ text: "", week: 1, day: "Monday", period: "AM", doctorIds: [] }}
          numWeeks={staging.num_weeks}
          activeDoctors={activeDoctors}
          saving={saving}
          error={error}
          open
          onOpenChange={(open) => {
            if (!open) setAddingOneOff(false);
          }}
          onSave={handleSaveOneOff}
        />
      ) : null}
    </section>
  );
}
