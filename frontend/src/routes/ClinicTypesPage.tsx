import { DndContext, PointerSensor, closestCenter, useSensor, useSensors } from "@dnd-kit/core";
import type { DragEndEvent } from "@dnd-kit/core";
import { SortableContext, arrayMove, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { useEffect, useState } from "react";

import { useClinicTypes, useDeleteClinicType, usePatchClinicType, useReorderClinicTypes } from "@/api/clinicTypes";
import type { ClinicType } from "@/api/types";
import { ClinicTypeFormDialog } from "@/components/ClinicTypeFormDialog";

interface DialogState {
  open: boolean;
  clinicType?: ClinicType;
}

const DAY_ORDER: Record<string, number> = {
  Monday: 0,
  Tuesday: 1,
  Wednesday: 2,
  Thursday: 3,
  Friday: 4,
};

const DAY_ABBREVIATION: Record<string, string> = {
  Monday: "Mon",
  Tuesday: "Tue",
  Wednesday: "Wed",
  Thursday: "Thu",
  Friday: "Fri",
};

/**
 * Renders every schedule slot as "Mon AM, Wed PM, ..." instead of a bare
 * count, sorted weekday-then-period so the list reads in week order
 * regardless of the order slots were added in the form.
 */
function formatSchedules(schedules: ClinicType["schedules"]): string {
  if (schedules.length === 0) return "-";
  return schedules
    .slice()
    .sort((a, b) => DAY_ORDER[a.day] - DAY_ORDER[b.day] || a.period.localeCompare(b.period))
    .map((s) => `${DAY_ABBREVIATION[s.day]} ${s.period}`)
    .join(", ");
}

interface ToggleHandlers {
  onToggleEnabled: (ct: ClinicType, checked: boolean) => void;
  onToggleRoomRequired: (ct: ClinicType, checked: boolean) => void;
  togglesDisabled: boolean;
}

function SortableClinicTypeRow({
  clinicType,
  onEdit,
  onDelete,
  onToggleEnabled,
  onToggleRoomRequired,
  togglesDisabled,
}: {
  clinicType: ClinicType;
  onEdit: (ct: ClinicType) => void;
  onDelete: (ct: ClinicType) => void;
} & ToggleHandlers) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: clinicType.id,
  });
  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
  };

  return (
    <tr ref={setNodeRef} style={style} className="border-t border-border">
      <td className="py-1 pr-2">
        <button
          type="button"
          aria-label={`Reorder ${clinicType.name}`}
          className="cursor-grab px-1 text-ink/50"
          {...attributes}
          {...listeners}
        >
          ::
        </button>
      </td>
      <td className="py-1 pr-4">{clinicType.name}</td>
      <td className="py-1 pr-4">
        <input
          type="checkbox"
          aria-label={`Room required for ${clinicType.name}`}
          checked={clinicType.room_required}
          disabled={togglesDisabled}
          onChange={(e) => onToggleRoomRequired(clinicType, e.target.checked)}
        />
      </td>
      <td className="py-1 pr-4">
        <input
          type="checkbox"
          aria-label={`Enabled for ${clinicType.name}`}
          checked={clinicType.is_enabled}
          disabled={togglesDisabled}
          onChange={(e) => onToggleEnabled(clinicType, e.target.checked)}
        />
      </td>
      <td className="py-1 pr-4">{formatSchedules(clinicType.schedules)}</td>
      <td className="py-1">
        <button type="button" onClick={() => onEdit(clinicType)} className="mr-3 text-xs text-accent">
          Edit
        </button>
        <button type="button" onClick={() => onDelete(clinicType)} className="text-xs text-red-700">
          Delete
        </button>
      </td>
    </tr>
  );
}

export function ClinicTypesPage() {
  const { data: clinicTypes, isLoading, isError } = useClinicTypes();
  const deleteClinicType = useDeleteClinicType();
  const reorderClinicTypes = useReorderClinicTypes();
  const patchClinicType = usePatchClinicType();
  const [dialogState, setDialogState] = useState<DialogState>({ open: false });
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [reorderError, setReorderError] = useState<string | null>(null);
  const [toggleError, setToggleError] = useState<string | null>(null);
  const [enabledOrder, setEnabledOrder] = useState<ClinicType[]>([]);

  // clinicTypes arrives from the API already ordered by clinic_priority,
  // which for enabled rows *is* the sequence to render - filtering
  // preserves it. Synced into local state (rather than derived inline on
  // every render) so a drag can reorder the list immediately, without
  // waiting on the mutation's round trip and refetch. Array position is
  // the only source of truth for order here - no separate priority field
  // is tracked client-side, mirroring reorderPreferredRooms.ts.
  useEffect(() => {
    if (clinicTypes) {
      setEnabledOrder(clinicTypes.filter((ct) => ct.is_enabled));
    }
  }, [clinicTypes]);

  // Disabled rows are never interleaved with the draggable list - their
  // stored clinic_priority is stale by definition (it's outside the
  // server's partial unique index once disabled), so it isn't shown or
  // relied on here. Sorted by name instead, purely for a stable, readable
  // order in an otherwise orderless group.
  const disabled = (clinicTypes ?? [])
    .filter((ct) => !ct.is_enabled)
    .slice()
    .sort((a, b) => a.name.localeCompare(b.name));

  const sensors = useSensors(useSensor(PointerSensor));

  function openCreate() {
    setDeleteError(null);
    setDialogState({ open: true, clinicType: undefined });
  }

  function openEdit(clinicType: ClinicType) {
    setDeleteError(null);
    setDialogState({ open: true, clinicType });
  }

  function handleDelete(clinicType: ClinicType) {
    if (!window.confirm(`Delete clinic type "${clinicType.name}"? This cannot be undone.`)) {
      return;
    }
    setDeleteError(null);
    deleteClinicType.mutate(clinicType.id, {
      onError: (err) => {
        setDeleteError(typeof err.detail === "string" ? err.detail : "Could not delete this clinic type.");
      },
    });
  }

  function handleDragEnd(event: DragEndEvent) {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const fromIndex = enabledOrder.findIndex((ct) => ct.id === active.id);
    const toIndex = enabledOrder.findIndex((ct) => ct.id === over.id);
    if (fromIndex === -1 || toIndex === -1) return;

    const previousOrder = enabledOrder;
    const reordered = arrayMove(enabledOrder, fromIndex, toIndex);
    setEnabledOrder(reordered);
    setReorderError(null);
    reorderClinicTypes.mutate(reordered.map((ct) => ct.id), {
      onError: (err) => {
        setEnabledOrder(previousOrder);
        setReorderError(typeof err.detail === "string" ? err.detail : "Could not reorder clinic types.");
      },
    });
  }

  // Both toggle handlers share one error slot and one mutation. All
  // checkboxes on the page are disabled while a patch is in flight (see
  // togglesDisabled below) rather than tracking per-row pending state -
  // this is what narrows a disable-toggle racing a drag reorder (the
  // reorder endpoint 409s on a stale enabled-id set), and the list this
  // size doesn't need anything finer-grained.
  function handleToggleEnabled(clinicType: ClinicType, checked: boolean) {
    setToggleError(null);
    patchClinicType.mutate(
      { id: clinicType.id, payload: { is_enabled: checked } },
      {
        onError: (err) => {
          setToggleError(typeof err.detail === "string" ? err.detail : "Could not update this clinic type.");
        },
      },
    );
  }

  function handleToggleRoomRequired(clinicType: ClinicType, checked: boolean) {
    setToggleError(null);
    patchClinicType.mutate(
      { id: clinicType.id, payload: { room_required: checked } },
      {
        onError: (err) => {
          setToggleError(typeof err.detail === "string" ? err.detail : "Could not update this clinic type.");
        },
      },
    );
  }

  const toggleHandlers: ToggleHandlers = {
    onToggleEnabled: handleToggleEnabled,
    onToggleRoomRequired: handleToggleRoomRequired,
    togglesDisabled: patchClinicType.isPending,
  };

  return (
    <div>
      <div className="flex items-center justify-between">
        <h1 className="text-lg font-semibold">Clinic Types</h1>
        <button
          type="button"
          onClick={openCreate}
          className="rounded bg-accent px-4 py-2 text-sm font-medium text-white"
        >
          New Clinic Type
        </button>
      </div>

      {deleteError ? <p className="mt-3 text-sm text-red-700">{deleteError}</p> : null}
      {reorderError ? <p className="mt-3 text-sm text-red-700">{reorderError}</p> : null}
      {toggleError ? <p className="mt-3 text-sm text-red-700">{toggleError}</p> : null}

      {isLoading ? <p className="mt-4 text-sm text-ink/70">Loading...</p> : null}
      {isError ? <p className="mt-4 text-sm text-red-700">Could not load clinic types.</p> : null}

      {clinicTypes && clinicTypes.length === 0 ? (
        <p className="mt-4 text-sm text-ink/50">
          No clinic types yet. Nothing will generate until at least one is added.
        </p>
      ) : null}

      {clinicTypes && clinicTypes.length > 0 ? (
        <>
          <h2 className="mt-4 text-sm font-semibold text-ink/70">Enabled</h2>
          <p className="mt-1 text-xs text-ink/50">Drag to reorder. Order determines generation priority.</p>
          {enabledOrder.length === 0 ? (
            <p className="mt-2 text-sm text-ink/50">No enabled clinic types.</p>
          ) : (
            <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
              <SortableContext items={enabledOrder.map((ct) => ct.id)} strategy={verticalListSortingStrategy}>
                <table className="mt-2 w-full table-fixed text-sm">
                  <colgroup>
                    <col className="w-8" />
                    <col className="w-1/4" />
                    <col className="w-28" />
                    <col className="w-20" />
                    <col />
                    <col className="w-28" />
                  </colgroup>
                  <thead>
                    <tr className="text-left text-ink/70">
                      <th className="py-1" />
                      <th className="py-1 pr-4 font-medium">Name</th>
                      <th className="py-1 pr-4 font-medium">Room required</th>
                      <th className="py-1 pr-4 font-medium">Enabled</th>
                      <th className="py-1 pr-4 font-medium">Schedule</th>
                      <th className="py-1" />
                    </tr>
                  </thead>
                  <tbody>
                    {enabledOrder.map((ct) => (
                      <SortableClinicTypeRow
                        key={ct.id}
                        clinicType={ct}
                        onEdit={openEdit}
                        onDelete={handleDelete}
                        {...toggleHandlers}
                      />
                    ))}
                  </tbody>
                </table>
              </SortableContext>
            </DndContext>
          )}

          {disabled.length > 0 ? (
            <>
              <h2 className="mt-6 text-sm font-semibold text-ink/70">Disabled</h2>
              <table className="mt-2 w-full table-fixed text-sm">
                <colgroup>
                  <col className="w-8" />
                  <col className="w-1/4" />
                  <col className="w-28" />
                  <col className="w-20" />
                  <col />
                  <col className="w-28" />
                </colgroup>
                <thead>
                  <tr className="text-left text-ink/70">
                    <th className="py-1" />
                    <th className="py-1 pr-4 font-medium">Name</th>
                    <th className="py-1 pr-4 font-medium">Room required</th>
                    <th className="py-1 pr-4 font-medium">Enabled</th>
                    <th className="py-1 pr-4 font-medium">Schedule</th>
                    <th className="py-1" />
                  </tr>
                </thead>
                <tbody>
                  {disabled.map((ct) => (
                    <tr key={ct.id} className="border-t border-border">
                      <td className="py-1" />
                      <td className="py-1 pr-4">{ct.name}</td>
                      <td className="py-1 pr-4">
                        <input
                          type="checkbox"
                          aria-label={`Room required for ${ct.name}`}
                          checked={ct.room_required}
                          disabled={toggleHandlers.togglesDisabled}
                          onChange={(e) => handleToggleRoomRequired(ct, e.target.checked)}
                        />
                      </td>
                      <td className="py-1 pr-4">
                        <input
                          type="checkbox"
                          aria-label={`Enabled for ${ct.name}`}
                          checked={ct.is_enabled}
                          disabled={toggleHandlers.togglesDisabled}
                          onChange={(e) => handleToggleEnabled(ct, e.target.checked)}
                        />
                      </td>
                      <td className="py-1 pr-4">{formatSchedules(ct.schedules)}</td>
                      <td className="py-1">
                        <button type="button" onClick={() => openEdit(ct)} className="mr-3 text-xs text-accent">
                          Edit
                        </button>
                        <button type="button" onClick={() => handleDelete(ct)} className="text-xs text-red-700">
                          Delete
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </>
          ) : null}
        </>
      ) : null}

      {dialogState.open ? (
        <ClinicTypeFormDialog
          key={dialogState.clinicType?.id ?? "new"}
          clinicType={dialogState.clinicType}
          open={dialogState.open}
          onOpenChange={(open) => setDialogState((s) => ({ ...s, open }))}
        />
      ) : null}
    </div>
  );
}