"""Phase 9B -- room swap elimination.

Detects exact AM/PM room swaps between pairs of Partner/Salaried doctors on
the same (week, day) and resolves them per the priority table in
algorithms.md. Only PM values ever change; AM values are never touched.

Since only PM can move, resolution is a binary choice:
  DEFAULT -- both doctors keep their own AM room for PM too (undoes the
    swap; neither doctor changes rooms mid-day).
  CONFIRM -- leave PM values exactly as already computed (the swap stands).

Rows 1/2/6/7 of the priority table map to DEFAULT; rows 3/4 map to CONFIRM.

Row 5 ("both prefer the same room; one Partner one Salaried -> Partner gets
it") is not implemented as a distinct case. Under strict top-to-bottom
"first matching row wins" evaluation of rows 1-4, row 5's own scenario is
unreachable: whenever one doctor prefers their own current room and the
other doctor prefers the opposite room, row 1 or row 2 ("only Doctor X
prefers their own AM room") already fires first, since those rows only look
at each doctor's *own*-room preference in isolation and don't consider what
the other doctor separately prefers about the swap room. This was confirmed
with the user, who chose to drop row 5 rather than reorder the table or add
extra conditions to rows 1-4 to make it reachable: if this exact conflict
arises, the outcome simply falls through to the same DEFAULT as rows 6/7.

"Preference match" (confirmed with the user) means the room appears
anywhere in the doctor's DoctorPreferredRoom list -- not restricted to
their #1 preference or to a currently-free room.

No counter is involved in this phase, and it never emits a ValidationIssue
-- resolution is fully deterministic for every detected swap.
"""
from __future__ import annotations

from ...models.enums import Day, DoctorType, MasterSessionType, Period
from ..datatypes import DecisionLog, GenerationContext, RotaGrid, ValidationIssue

PHASE = "phase9b"

_DAYS = (Day.MONDAY, Day.TUESDAY, Day.WEDNESDAY, Day.THURSDAY, Day.FRIDAY)
_SWAPPABLE_TYPES = (DoctorType.PARTNER, DoctorType.SALARIED)


def run_phase9b(
    context: GenerationContext, grid: RotaGrid, log: DecisionLog
) -> list[ValidationIssue]:
    num_weeks = max((gw for gw, _day in context.week_dates.keys()), default=0)

    for gen_week in range(1, num_weeks + 1):
        for day in _DAYS:
            _resolve_swaps_for_day(context, grid, gen_week, day, log)

    return []


def _resolve_swaps_for_day(
    context: GenerationContext, grid: RotaGrid, gen_week: int, day: Day, log: DecisionLog
) -> None:
    candidates = _eligible_doctors_for_day(context, grid, gen_week, day)
    doctor_ids = sorted(candidates.keys(), key=lambda did: context.doctor_by_id[did].code)

    processed: set[int] = set()
    for i, a_id in enumerate(doctor_ids):
        if a_id in processed:
            continue
        a_am, a_pm = candidates[a_id]
        if a_am == a_pm:
            continue  # no mid-day room change for A -- not part of any swap

        for b_id in doctor_ids[i + 1:]:
            if b_id in processed:
                continue
            b_am, b_pm = candidates[b_id]
            if b_am == b_pm:
                continue

            if a_am == b_pm and a_pm == b_am:
                confirm = _should_confirm_swap(context, a_id, b_id, a_am, b_am)
                if not confirm:
                    # Free both current PM rooms first -- assign_room only
                    # frees the assignee's own prior room, not a target
                    # room's existing occupant, so assigning A straight into
                    # X while B still holds X would leave the grid's
                    # occupancy indexes inconsistent.
                    grid.free_room(gen_week, day, Period.PM, a_id)
                    grid.free_room(gen_week, day, Period.PM, b_id)
                    grid.assign_room(gen_week, day, Period.PM, a_id, a_am)
                    grid.assign_room(gen_week, day, Period.PM, b_id, b_am)
                processed.add(a_id)
                processed.add(b_id)
                break


def _eligible_doctors_for_day(
    context: GenerationContext, grid: RotaGrid, gen_week: int, day: Day
) -> dict[int, tuple[int, int]]:
    """doctor_id -> (am_room_id, pm_room_id) for Partner/Salaried doctors with
    fully resolved, non-leave, non-NO_SURGERY sessions both AM and PM."""
    result: dict[int, tuple[int, int]] = {}
    for doctor in context.doctors:
        if doctor.doctor_type not in _SWAPPABLE_TYPES:
            continue
        am_slot = grid.get(doctor.id, gen_week, day, Period.AM)
        pm_slot = grid.get(doctor.id, gen_week, day, Period.PM)
        if am_slot is None or pm_slot is None:
            continue
        if am_slot.is_on_leave or pm_slot.is_on_leave:
            continue
        if am_slot.template_type == MasterSessionType.NO_SURGERY:
            continue
        if pm_slot.template_type == MasterSessionType.NO_SURGERY:
            continue
        if am_slot.assigned_room_id is None or pm_slot.assigned_room_id is None:
            continue  # unresolvable session
        result[doctor.id] = (am_slot.assigned_room_id, pm_slot.assigned_room_id)
    return result


def _should_confirm_swap(
    context: GenerationContext, a_id: int, b_id: int, x_room: int, y_room: int,
) -> bool:
    """True to CONFIRM (keep) the swap; False to DEFAULT (undo) it.

    x_room = Doctor A's AM room (and B's swapped PM room);
    y_room = Doctor B's AM room (and A's swapped PM room).
    """
    a_pref = context.preferred_rooms_by_doctor.get(a_id, ())
    b_pref = context.preferred_rooms_by_doctor.get(b_id, ())

    a_prefers_own = x_room in a_pref
    a_prefers_other = y_room in a_pref
    b_prefers_own = y_room in b_pref
    b_prefers_other = x_room in b_pref

    if a_prefers_own and not b_prefers_own:
        return False  # row 1
    if b_prefers_own and not a_prefers_own:
        return False  # row 2
    if a_prefers_other and not b_prefers_other:
        return True  # row 3
    if b_prefers_other and not a_prefers_other:
        return True  # row 4

    return False  # rows 5-7 all collapse to default (row 5 dropped -- see
    # module docstring; rows 6/7 were already default)