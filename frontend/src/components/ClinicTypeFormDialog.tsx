import * as Dialog from "@radix-ui/react-dialog";
import { useState } from "react";
import type { FormEvent } from "react";

import { useCreateClinicType, useUpdateClinicType } from "@/api/clinicTypes";
import { useDoctors } from "@/api/doctors";
import { useRooms } from "@/api/rooms";
import type { ClinicType, Day, DoctorType, Period, RoomType } from "@/api/types";
import { groupDoctorsByType } from "@/lib/groupDoctors";
import {
  type ClinicTypeFormValues,
  clinicTypeFormSchema,
  emptyFormValues,
  formValuesFromClinicType,
  mapZodFieldErrors,
  toWirePayload,
} from "@/lib/clinicTypeSchema";
import { mapValidationErrors } from "@/lib/mapValidationErrors";

const DAYS: Day[] = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday"];
const PERIODS: Period[] = ["AM", "PM"];
const ROOM_TYPES: RoomType[] = ["D", "C", "W", "SR"];

interface ClinicTypeFormDialogProps {
  /** undefined = create mode. Render with a `key` on the clinic type's id
   * (or "new") from the parent, so switching which record is being
   * edited remounts this component and its form state resets cleanly,
   * rather than needing an effect to detect the switch. */
  clinicType?: ClinicType;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function ClinicTypeFormDialog({ clinicType, open, onOpenChange }: ClinicTypeFormDialogProps) {
  const { data: doctors } = useDoctors(false);
  const { data: rooms } = useRooms();
  const createClinicType = useCreateClinicType();
  const updateClinicType = useUpdateClinicType();

  const [values, setValues] = useState<ClinicTypeFormValues>(() =>
    clinicType ? formValuesFromClinicType(clinicType) : emptyFormValues(),
  );
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);

  const doctorsById = new Map((doctors ?? []).map((d) => [d.id, d]));
  const roomsById = new Map((rooms ?? []).map((r) => [r.id, r]));
  const activeDoctors = (doctors ?? []).filter((d) => d.active);
  const isSaving = createClinicType.isPending || updateClinicType.isPending;

  // Filter *before* grouping: groupDoctorsByType omits a type entirely
  // when it has no doctors in the list it's given, so passing the
  // not-yet-added list (rather than all active doctors) is what makes a
  // fully-added type's group - and its "All <type>" bulk option - vanish
  // once there's nothing left to add.
  const notYetAddedDoctors = activeDoctors.filter(
    (d) => !values.doctorEligibilities.some((row) => row.doctorId === d.id),
  );
  const notYetAddedGroups = groupDoctorsByType(notYetAddedDoctors);

  function toggleSchedule(day: Day, period: Period) {
    setValues((prev) => {
      const exists = prev.schedules.some((s) => s.day === day && s.period === period);
      return {
        ...prev,
        schedules: exists
          ? prev.schedules.filter((s) => !(s.day === day && s.period === period))
          : [...prev.schedules, { day, period }],
      };
    });
  }

  function addDoctorEligibility(doctorId: number) {
    setValues((prev) => ({
      ...prev,
      doctorEligibilities: [...prev.doctorEligibilities, { doctorId, doctorPriority: 1000 }],
    }));
  }

  /**
   * Bulk-add ("All doctors" / "All partners" etc.) - one state update for
   * every id at once, rather than calling addDoctorEligibility in a loop
   * (which would both be N re-renders and, worse, N reads of the same
   * stale `prev` if not written as an updater function each time). Callers
   * are expected to have already excluded ids already present.
   */
  function addManyDoctorEligibilities(doctorIds: number[]) {
    if (doctorIds.length === 0) return;
    setValues((prev) => ({
      ...prev,
      doctorEligibilities: [
        ...prev.doctorEligibilities,
        ...doctorIds.map((doctorId) => ({ doctorId, doctorPriority: 1000 })),
      ],
    }));
  }

  function updateDoctorPriority(index: number, doctorPriority: number) {
    setValues((prev) => ({
      ...prev,
      doctorEligibilities: prev.doctorEligibilities.map((row, i) =>
        i === index ? { ...row, doctorPriority } : row,
      ),
    }));
  }

  function removeDoctorEligibility(index: number) {
    setValues((prev) => ({
      ...prev,
      doctorEligibilities: prev.doctorEligibilities.filter((_, i) => i !== index),
    }));
  }

  function addRoomEligibility(roomId: number) {
    setValues((prev) => ({
      ...prev,
      roomEligibilities: [...prev.roomEligibilities, { kind: "room", roomId }],
    }));
  }

  function addRoomTypeEligibility(roomType: RoomType) {
    setValues((prev) => ({
      ...prev,
      roomEligibilities: [...prev.roomEligibilities, { kind: "roomType", roomType }],
    }));
  }

  function removeRoomEligibility(index: number) {
    setValues((prev) => ({
      ...prev,
      roomEligibilities: prev.roomEligibilities.filter((_, i) => i !== index),
    }));
  }

  function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setFieldErrors({});
    setFormError(null);

    const result = clinicTypeFormSchema.safeParse(values);
    if (!result.success) {
      // Every issue this schema can produce has a path of length 1 -
      // either a top-level scalar field ("name") or one of the two
      // array-level refine keys ("doctorEligibilities",
      // "roomEligibilities"). mapZodFieldErrors covers all of them, so
      // there's no remaining case that needs a separate top-of-form
      // message here.
      setFieldErrors(mapZodFieldErrors(result.error));
      return;
    }

    const payload = toWirePayload(result.data);
    const onError = (err: { status: number; detail: unknown }) => {
      if (err.status === 422 && Array.isArray(err.detail)) {
        const mapped = mapValidationErrors(err.detail);
        setFieldErrors(mapped.fieldErrors);
        setFormError(mapped.formErrors[0] ?? "Could not save this clinic type.");
      } else if (typeof err.detail === "string") {
        setFormError(err.detail);
      } else {
        setFormError("Could not save this clinic type.");
      }
    };

    if (clinicType) {
      updateClinicType.mutate(
        { id: clinicType.id, payload },
        { onSuccess: () => onOpenChange(false), onError },
      );
    } else {
      createClinicType.mutate(payload, { onSuccess: () => onOpenChange(false), onError });
    }
  }

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 bg-ink/30" />
        <Dialog.Content className="fixed left-1/2 top-1/2 max-h-[90vh] w-[36rem] -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded bg-surface p-5 shadow-lg">
          <Dialog.Title className="text-lg font-semibold">
            {clinicType ? `Edit ${clinicType.name}` : "New Clinic Type"}
          </Dialog.Title>

          <form onSubmit={handleSubmit} className="mt-4 space-y-4">
            {formError ? <p className="rounded bg-red-50 p-2 text-sm text-red-700">{formError}</p> : null}

            <div>
              <label className="block text-sm font-medium" htmlFor="ct-name">
                Name
              </label>
              <input
                id="ct-name"
                type="text"
                value={values.name}
                onChange={(e) => setValues((v) => ({ ...v, name: e.target.value }))}
                className="mt-1 w-full rounded border border-border p-1 text-sm"
              />
              {fieldErrors.name ? <p className="mt-1 text-xs text-red-700">{fieldErrors.name}</p> : null}
            </div>

            <div>
              <label className="block text-sm font-medium" htmlFor="ct-category">
                Category
              </label>
              <input
                id="ct-category"
                type="text"
                value={values.category}
                onChange={(e) => setValues((v) => ({ ...v, category: e.target.value }))}
                className="mt-1 w-full rounded border border-border p-1 text-sm"
                placeholder="e.g. duty_helper"
              />
              <p className="mt-1 text-xs text-ink/50">
                Free text. The grid colours a session light blue instead of green when this is exactly
                "duty_helper" - leave blank for an ordinary named clinic.
              </p>
            </div>

            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={values.isEnabled}
                onChange={(e) => setValues((v) => ({ ...v, isEnabled: e.target.checked }))}
              />
              Enabled (generation skips disabled clinic types)
            </label>

            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={values.roomRequired}
                onChange={(e) => setValues((v) => ({ ...v, roomRequired: e.target.checked }))}
              />
              Room required
            </label>

            <fieldset>
              <legend className="text-sm font-medium">Schedule</legend>
              <table className="mt-1 text-sm">
                <thead>
                  <tr>
                    <th />
                    {PERIODS.map((period) => (
                      <th key={period} className="px-2 font-medium text-ink/70">
                        {period}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {DAYS.map((day) => (
                    <tr key={day}>
                      <td className="pr-2 text-ink/70">{day}</td>
                      {PERIODS.map((period) => (
                        <td key={period} className="px-2 text-center">
                          <input
                            type="checkbox"
                            aria-label={`${day} ${period}`}
                            checked={values.schedules.some((s) => s.day === day && s.period === period)}
                            onChange={() => toggleSchedule(day, period)}
                          />
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </fieldset>

            <fieldset>
              <legend className="text-sm font-medium">Doctor eligibility</legend>
              <ul className="mt-1 space-y-1" aria-label="Doctor eligibility rows">
                {values.doctorEligibilities.map((row, index) => {
                  const doctor = doctorsById.get(row.doctorId);
                  return (
                    <li key={row.doctorId} className="flex items-center gap-2 text-sm">
                      <span className="flex-1">
                        {doctor?.code ?? `Doctor ${row.doctorId}`}
                        {doctor && !doctor.active ? <span className="text-ink/50"> (inactive)</span> : null}
                      </span>
                      <input
                        type="number"
                        aria-label={`Priority for ${doctor?.code ?? row.doctorId}`}
                        value={row.doctorPriority}
                        onChange={(e) => updateDoctorPriority(index, Number(e.target.value))}
                        className="w-20 rounded border border-border p-1 text-sm"
                      />
                      <button
                        type="button"
                        onClick={() => removeDoctorEligibility(index)}
                        className="text-xs text-red-700"
                      >
                        Remove
                      </button>
                    </li>
                  );
                })}
              </ul>
              {fieldErrors.doctorEligibilities ? (
                <p className="mt-1 text-xs text-red-700">{fieldErrors.doctorEligibilities}</p>
              ) : null}
              <select
                aria-label="Add doctor"
                defaultValue=""
                onChange={(e) => {
                  const val = e.target.value;
                  if (val === "all") {
                    addManyDoctorEligibilities(notYetAddedDoctors.map((d) => d.id));
                  } else if (val.startsWith("all:")) {
                    const type = val.slice(4) as DoctorType;
                    addManyDoctorEligibilities(
                      notYetAddedDoctors.filter((d) => d.doctor_type === type).map((d) => d.id),
                    );
                  } else if (val) {
                    addDoctorEligibility(Number(val));
                  }
                  e.target.value = "";
                }}
                className="mt-2 rounded border border-border p-1 text-sm"
              >
                <option value="" disabled>
                  Add doctor...
                </option>
                {notYetAddedDoctors.length > 0 ? <option value="all">All doctors</option> : null}
                {notYetAddedGroups.map((group) => (
                  <optgroup key={group.type} label={group.label}>
                    <option value={`all:${group.type}`}>All {group.type === "AHP" ? "AHP" : group.label.toLowerCase()}</option>
                    {group.doctors.map((d) => (
                      <option key={d.id} value={d.id}>
                        {d.code}
                      </option>
                    ))}
                  </optgroup>
                ))}
              </select>
            </fieldset>

            <fieldset>
              <legend className="text-sm font-medium">Room eligibility</legend>
              <ul className="mt-1 space-y-1" aria-label="Room eligibility rows">
                {values.roomEligibilities.map((row, index) => (
                  <li key={index} className="flex items-center gap-2 text-sm">
                    <span className="flex-1">
                      {row.kind === "room" ? (roomsById.get(row.roomId)?.code ?? `Room ${row.roomId}`) : `Room type: ${row.roomType}`}
                    </span>
                    <button
                      type="button"
                      onClick={() => removeRoomEligibility(index)}
                      className="text-xs text-red-700"
                    >
                      Remove
                    </button>
                  </li>
                ))}
              </ul>
              {fieldErrors.roomEligibilities ? (
                <p className="mt-1 text-xs text-red-700">{fieldErrors.roomEligibilities}</p>
              ) : null}
              <div className="mt-2 flex gap-2">
                <select
                  aria-label="Add specific room"
                  defaultValue=""
                  onChange={(e) => {
                    if (e.target.value) addRoomEligibility(Number(e.target.value));
                    e.target.value = "";
                  }}
                  className="rounded border border-border p-1 text-sm"
                >
                  <option value="" disabled>
                    Add specific room...
                  </option>
                  {(rooms ?? [])
                    .filter((r) => !values.roomEligibilities.some((row) => row.kind === "room" && row.roomId === r.id))
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
                    if (e.target.value) addRoomTypeEligibility(e.target.value as RoomType);
                    e.target.value = "";
                  }}
                  className="rounded border border-border p-1 text-sm"
                >
                  <option value="" disabled>
                    Add room type...
                  </option>
                  {ROOM_TYPES.filter(
                    (rt) => !values.roomEligibilities.some((row) => row.kind === "roomType" && row.roomType === rt),
                  ).map((rt) => (
                    <option key={rt} value={rt}>
                      {rt}
                    </option>
                  ))}
                </select>
              </div>
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
