import type { DutyAssignment, DutyType, Period } from "@/api/types";

export interface DraggableDoctor {
  doctorId: number;
  doctorCode: string;
}

export interface DutySlot {
  date: string;
  period: Period;
  dutyType: DutyType;
  /** The existing assignment occupying this slot, or null if empty. */
  assignment: DutyAssignment | null;
}

export interface DutyDropOutcome {
  doctorId: number;
  date: string;
  period: Period;
  dutyType: DutyType;
  /** Non-null if the target slot is already occupied - the caller must
   * confirm with the user and delete this assignment before creating
   * the new one. Null means the slot was empty: create only. */
  existingAssignmentId: number | null;
}

/**
 * Pure resolution of a dnd-kit onDragEnd event's active/over data for
 * the duty grid into either nothing to do, or a slot to fill (and, if
 * occupied, the existing assignment id that must be cleared first).
 *
 * Kept separate from DutyGrid's handleDragEnd specifically so this
 * logic is unit-testable without needing real dnd-kit pointer
 * simulation, which requires bounding rects jsdom doesn't provide -
 * mirrors the established resolveDrag.ts precedent for RotaGrid.
 */
export function resolveDutyDrop(
  active: DraggableDoctor | undefined,
  over: DutySlot | undefined,
): DutyDropOutcome | null {
  if (!active || !over) return null;
  // Dropping a doctor back onto the slot they already occupy is a no-op,
  // not a "replace with the same doctor" round trip through the API.
  if (over.assignment && over.assignment.doctor_id === active.doctorId) return null;

  return {
    doctorId: active.doctorId,
    date: over.date,
    period: over.period,
    dutyType: over.dutyType,
    existingAssignmentId: over.assignment ? over.assignment.id : null,
  };
}