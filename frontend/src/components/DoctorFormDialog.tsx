import * as Dialog from "@radix-ui/react-dialog";
import { DndContext, PointerSensor, closestCenter, useSensor, useSensors } from "@dnd-kit/core";
import type { DragEndEvent } from "@dnd-kit/core";
import { SortableContext, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { useEffect, useState } from "react";
import type { FormEvent } from "react";

import { useCreateDoctor, useDoctor, useReplacePreferredRooms, useUpdateDoctor } from "@/api/doctors";
import { useRooms } from "@/api/rooms";
import type { ApiError, Doctor, DoctorType, RoomType, SupervisionPreference } from "@/api/types";
import {
  type DoctorFormValues,
  doctorFormSchema,
  emptyFormValues,
  formValuesFromDoctor,
  mapZodFieldErrors,
  toWirePayload,
} from "@/lib/doctorSchema";
import { type PreferredRoomRow, moveRow, toWireRows } from "@/lib/reorderPreferredRooms";

const DOCTOR_TYPES: DoctorType[] = ["Partner", "Salaried", "Trainee", "Locum", "AHP"];
const ROOM_TYPES: RoomType[] = ["D", "C", "W", "SR"];
const SUPERVISION_PREFERENCES: { value: SupervisionPreference; label: string }[] = [
  { value: "none", label: "None" },
  { value: "less", label: "Less" },
  { value: "normal", label: "Normal" },
  { value: "more", label: "More" },
];

interface DoctorFormDialogProps {
  /** undefined = create mode. Render with a `key` on the doctor's id (or
   * "new") from the parent, so switching which record is being edited
   * remounts this component and its form state resets cleanly. */
  doctor?: Doctor;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

let rowIdCounter = 0;
function nextRowId(): string {
  rowIdCounter += 1;
  return `row-${rowIdCounter}`;
}

function SortableRow({
  row,
  label,
  onRemove,
}: {
  row: PreferredRoomRow;
  label: string;
  onRemove: () => void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: row.id });
  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
  };

  return (
    <li ref={setNodeRef} style={style} className="flex items-center gap-2 rounded border border-border bg-surface p-1 text-sm">
      <button
        type="button"
        aria-label={`Reorder ${label}`}
        className="cursor-grab px-1 text-ink/50"
        {...attributes}
        {...listeners}
      >
        ::
      </button>
      <span className="flex-1">{label}</span>
      <button type="button" onClick={onRemove} className="text-xs text-red-700">
        Remove
      </button>
    </li>
  );
}

export function DoctorFormDialog({ doctor, open, onOpenChange }: DoctorFormDialogProps) {
  const { data: rooms } = useRooms();
  const { data: detail } = useDoctor(doctor?.id);
  const createDoctor = useCreateDoctor();
  const updateDoctor = useUpdateDoctor();
  const replacePreferredRooms = useReplacePreferredRooms();

  const [values, setValues] = useState<DoctorFormValues>(() =>
    doctor ? formValuesFromDoctor(doctor) : emptyFormValues(),
  );
  const [rows, setRows] = useState<PreferredRoomRow[]>([]);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [partialSaveNote, setPartialSaveNote] = useState<string | null>(null);

  // detail arrives async (a separate GET from the list), so seed the
  // preferred-rooms rows once it's in - not on every render.
  useEffect(() => {
    if (detail) {
      setRows(
        detail.preferred_rooms.map((r) =>
          r.room_id !== null
            ? { id: nextRowId(), kind: "room" as const, roomId: r.room_id }
            : { id: nextRowId(), kind: "roomType" as const, roomType: r.room_type as RoomType },
        ),
      );
    }
  }, [detail]);

  const roomsById = new Map((rooms ?? []).map((r) => [r.id, r]));
  const isSaving = createDoctor.isPending || updateDoctor.isPending || replacePreferredRooms.isPending;

  const sensors = useSensors(useSensor(PointerSensor));

  function handleDragEnd(event: DragEndEvent) {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const fromIndex = rows.findIndex((r) => r.id === active.id);
    const toIndex = rows.findIndex((r) => r.id === over.id);
    if (fromIndex === -1 || toIndex === -1) return;
    setRows((prev) => moveRow(prev, fromIndex, toIndex));
  }

  function addRoomRow(roomId: number) {
    setRows((prev) => [...prev, { id: nextRowId(), kind: "room", roomId }]);
  }

  function addRoomTypeRow(roomType: RoomType) {
    setRows((prev) => [...prev, { id: nextRowId(), kind: "roomType", roomType }]);
  }

  function removeRow(id: string) {
    setRows((prev) => prev.filter((r) => r.id !== id));
  }

  function labelForRow(row: PreferredRoomRow): string {
    if (row.kind === "room") {
      return roomsById.get(row.roomId)?.code ?? `Room ${row.roomId}`;
    }
    return `Room type: ${row.roomType}`;
  }

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setFieldErrors({});
    setFormError(null);
    setPartialSaveNote(null);

    const result = doctorFormSchema.safeParse(values);
    if (!result.success) {
      setFieldErrors(mapZodFieldErrors(result.error));
      return;
    }
    const payload = toWirePayload(result.data);

    const onDoctorError = (err: ApiError) => {
      if (typeof err.detail === "string") {
        setFormError(err.detail);
      } else {
        setFormError("Could not save this doctor.");
      }
    };

    if (!doctor) {
      createDoctor.mutate(payload, { onSuccess: () => onOpenChange(false), onError: onDoctorError });
      return;
    }

    // Edit mode: PATCH the scalar fields, then PUT the preferred rooms.
    // Sequential and deliberately not rolled back on partial failure -
    // faking atomicity client-side would misrepresent what the server
    // actually holds. A PATCH success followed by a PUT failure is
    // reported honestly as a partial save.
    updateDoctor.mutate(
      { id: doctor.id, payload },
      {
        onError: onDoctorError,
        onSuccess: () => {
          replacePreferredRooms.mutate(
            { doctorId: doctor.id, rows: toWireRows(rows) },
            {
              onSuccess: () => onOpenChange(false),
              onError: (err) => {
                const detail =
                  typeof err.detail === "string" ? err.detail : "Preferred rooms could not be saved.";
                setPartialSaveNote(`Doctor details saved. ${detail}`);
              },
            },
          );
        },
      },
    );
  }

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 bg-ink/30" />
        <Dialog.Content className="fixed left-1/2 top-1/2 max-h-[90vh] w-[28rem] -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded bg-surface p-5 shadow-lg">
          <Dialog.Title className="text-lg font-semibold">
            {doctor ? `Edit ${doctor.code}` : "New Doctor"}
          </Dialog.Title>

          <form onSubmit={handleSubmit} className="mt-4 space-y-4">
            {formError ? <p className="rounded bg-red-50 p-2 text-sm text-red-700">{formError}</p> : null}
            {partialSaveNote ? (
              <p className="rounded bg-amber-50 p-2 text-sm text-amber-800">{partialSaveNote}</p>
            ) : null}

            <div>
              <label className="block text-sm font-medium" htmlFor="doc-code">
                Code
              </label>
              <input
                id="doc-code"
                type="text"
                value={values.code}
                onChange={(e) => setValues((v) => ({ ...v, code: e.target.value }))}
                className="mt-1 w-full rounded border border-border p-1 text-sm"
              />
              {fieldErrors.code ? <p className="mt-1 text-xs text-red-700">{fieldErrors.code}</p> : null}
            </div>

            <div>
              <label className="block text-sm font-medium" htmlFor="doc-type">
                Type
              </label>
              <select
                id="doc-type"
                value={values.doctorType}
                onChange={(e) => setValues((v) => ({ ...v, doctorType: e.target.value as DoctorType }))}
                className="mt-1 w-full rounded border border-border p-1 text-sm"
              >
                {DOCTOR_TYPES.map((t) => (
                  <option key={t} value={t}>
                    {t}
                  </option>
                ))}
              </select>
            </div>

            <div>
              <label className="block text-sm font-medium" htmlFor="doc-sessions">
                Sessions per week
              </label>
              <input
                id="doc-sessions"
                type="number"
                step="0.5"
                min="0"
                value={values.sessionsPerWeek}
                onChange={(e) => setValues((v) => ({ ...v, sessionsPerWeek: Number(e.target.value) }))}
                className="mt-1 w-full rounded border border-border p-1 text-sm"
              />
              {fieldErrors.sessionsPerWeek ? (
                <p className="mt-1 text-xs text-red-700">{fieldErrors.sessionsPerWeek}</p>
              ) : null}
            </div>

            <div>
              <label className="block text-sm font-medium" htmlFor="doc-supervision-preference">
                Supervision preference
              </label>
              <select
                id="doc-supervision-preference"
                value={values.supervisionPreference}
                onChange={(e) =>
                  setValues((v) => ({ ...v, supervisionPreference: e.target.value as SupervisionPreference }))
                }
                className="mt-1 w-full rounded border border-border p-1 text-sm"
              >
                {SUPERVISION_PREFERENCES.map((p) => (
                  <option key={p.value} value={p.value}>
                    {p.label}
                  </option>
                ))}
              </select>
            </div>

            <fieldset>
              <legend className="text-sm font-medium">Employment dates</legend>
              <p className="mt-1 text-xs text-ink/50">
                Leave blank for no limit. Outside these dates the doctor gets no sessions when a rota is
                generated.
              </p>
              <div className="mt-2 flex gap-3">
                <div className="flex-1">
                  <label className="block text-xs text-ink/70" htmlFor="doc-start-date">
                    Start date
                  </label>
                  <input
                    id="doc-start-date"
                    type="date"
                    value={values.startDate}
                    onChange={(e) => setValues((v) => ({ ...v, startDate: e.target.value }))}
                    className="mt-1 w-full rounded border border-border p-1 text-sm"
                  />
                  {fieldErrors.startDate ? (
                    <p className="mt-1 text-xs text-red-700">{fieldErrors.startDate}</p>
                  ) : null}
                </div>
                <div className="flex-1">
                  <label className="block text-xs text-ink/70" htmlFor="doc-end-date">
                    End date
                  </label>
                  <input
                    id="doc-end-date"
                    type="date"
                    value={values.endDate}
                    onChange={(e) => setValues((v) => ({ ...v, endDate: e.target.value }))}
                    className="mt-1 w-full rounded border border-border p-1 text-sm"
                  />
                  {fieldErrors.endDate ? (
                    <p className="mt-1 text-xs text-red-700">{fieldErrors.endDate}</p>
                  ) : null}
                </div>
              </div>
            </fieldset>

            {doctor ? (
              <fieldset>
                <legend className="text-sm font-medium">Preferred rooms</legend>
                <p className="mt-1 text-xs text-ink/50">
                  Drag to reorder. First row is the preferred room; the rest are alternates, tried in order.
                </p>
                <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
                  <SortableContext items={rows.map((r) => r.id)} strategy={verticalListSortingStrategy}>
                    <ul className="mt-2 space-y-1" aria-label="Preferred room rows">
                      {rows.map((row) => (
                        <SortableRow
                          key={row.id}
                          row={row}
                          label={labelForRow(row)}
                          onRemove={() => removeRow(row.id)}
                        />
                      ))}
                    </ul>
                  </SortableContext>
                </DndContext>
                <div className="mt-2 flex gap-2">
                  <select
                    aria-label="Add specific room"
                    defaultValue=""
                    onChange={(e) => {
                      if (e.target.value) addRoomRow(Number(e.target.value));
                      e.target.value = "";
                    }}
                    className="rounded border border-border p-1 text-sm"
                  >
                    <option value="" disabled>
                      Add specific room...
                    </option>
                    {(rooms ?? [])
                      .filter((r) => !rows.some((row) => row.kind === "room" && row.roomId === r.id))
                      .map((r) => (
                        <option key={r.id} value={r.id}>
                          {r.code}
                        </option>
                      ))}
                  </select>
                  <select
                    aria-label="Add room type"
                    defaultValue=""
                    onChange={(e) => {
                      if (e.target.value) addRoomTypeRow(e.target.value as RoomType);
                      e.target.value = "";
                    }}
                    className="rounded border border-border p-1 text-sm"
                  >
                    <option value="" disabled>
                      Add room type...
                    </option>
                    {ROOM_TYPES.filter(
                      (rt) => !rows.some((row) => row.kind === "roomType" && row.roomType === rt),
                    ).map((rt) => (
                      <option key={rt} value={rt}>
                        {rt}
                      </option>
                    ))}
                  </select>
                </div>
              </fieldset>
            ) : (
              <p className="text-xs text-ink/50">
                Preferred rooms can be added once this doctor is saved - reopen Edit afterwards.
              </p>
            )}

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