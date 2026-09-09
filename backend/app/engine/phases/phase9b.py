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
-- resolution is fully deterministic for every detected swap. It does emit
one DecisionLogEntry per detected pair (see `run_phase9b`'s module-level
consumer, `generate._write_to_db()`), since this phase has no other output
to inspect after the fact.
"""
from __future__ import annotations

from ...models.enums import Day, DoctorType, MasterSessionType, Period
from .. import rationale as rat
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
                confirm, reason = _should_confirm_swap(context, a_id, b_id, a_am, b_am)
                entry_rationale = _swap_rationale(
                    context, a_id, b_id, a_am, b_am, confirm, reason,
                )
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

                log.add(
                    phase=PHASE, action="resolve_swap",
                    week=gen_week, day=day, period=None, doctor_id=a_id,
                    related_doctor_id=b_id, room_id=a_am, related_room_id=b_am,
                    message=(
                        f"Detected AM/PM room swap between "
                        f"{context.doctor_by_id[a_id].code} "
                        f"({context.room_by_id[a_am].code}) and "
                        f"{context.doctor_by_id[b_id].code} "
                        f"({context.room_by_id[b_am].code}): "
                        f"{'CONFIRMED' if confirm else 'DEFAULTED'} ({reason}). "
                        f"Only the PM assignment is ever mutated by this "
                        f"phase."
                    ),
                    rationale=entry_rationale,
                )
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


def _swap_rationale(
    context: GenerationContext, a_id: int, b_id: int, x_room: int, y_room: int,
    confirm: bool, reason: str,
) -> str:
    """The four preference facts the priority table is evaluated against,
    then the row that fired and what it did.

    The facts are listed whichever row wins, because the common debugging
    question here is not "which row fired" -- the message already says that
    -- but "is the doctor's room preference list what I think it is".
    """
    a_code = context.doctor_by_id[a_id].code
    b_code = context.doctor_by_id[b_id].code
    x_code = context.room_by_id[x_room].code
    y_code = context.room_by_id[y_room].code
    a_pref = context.preferred_rooms_by_doctor.get(a_id, ())
    b_pref = context.preferred_rooms_by_doctor.get(b_id, ())

    def _has(pref, room_id: int) -> str:
        return "yes" if room_id in pref else "no"

    return rat.stages(
        f"{a_code} is in {x_code} in AM and {y_code} in PM; {b_code} is the exact "
        f"mirror ({y_code} AM, {x_code} PM), which is what makes this a swap.",
        rat.listing(
            "Preference facts the priority table reads (a room counts as preferred "
            "if it appears anywhere on the doctor's list, not just at the top)",
            [
                f"{a_code} prefers their own AM room {x_code}: {_has(a_pref, x_room)}",
                f"{a_code} prefers the swap room {y_code}: {_has(a_pref, y_room)}",
                f"{b_code} prefers their own AM room {y_code}: {_has(b_pref, y_room)}",
                f"{b_code} prefers the swap room {x_code}: {_has(b_pref, x_room)}",
            ],
        ),
        rat.decided(
            f"{reason} -- "
            + (
                "CONFIRM, so the PM rooms are left exactly as the earlier phases "
                "computed them and both doctors change rooms at lunchtime"
                if confirm else
                "DEFAULT, so both doctors keep their own AM room for PM and neither "
                "changes rooms mid-day"
            )
        ),
    )


def _should_confirm_swap(
    context: GenerationContext, a_id: int, b_id: int, x_room: int, y_room: int,
) -> tuple[bool, str]:
    """(confirm, reason) -- confirm=True to CONFIRM (keep) the swap, False
    to DEFAULT (undo) it. `reason` names the priority-table row that fired,
    for the decision log.

    x_room = Doctor A's AM room (and B's swapped PM room);
    y_room = Doctor B's AM room (and A's swapped PM room).
    """
    a_code = context.doctor_by_id[a_id].code
    b_code = context.doctor_by_id[b_id].code

    a_pref = context.preferred_rooms_by_doctor.get(a_id, ())
    b_pref = context.preferred_rooms_by_doctor.get(b_id, ())

    a_prefers_own = x_room in a_pref
    a_prefers_other = y_room in a_pref
    b_prefers_own = y_room in b_pref
    b_prefers_other = x_room in b_pref

    if a_prefers_own and not b_prefers_own:
        return False, f"row 1: only {a_code} prefers their own AM room"
    if b_prefers_own and not a_prefers_own:
        return False, f"row 2: only {b_code} prefers their own AM room"
    if a_prefers_other and not b_prefers_other:
        return True, f"row 3: only {a_code} prefers the swap room"
    if b_prefers_other and not a_prefers_other:
        return True, f"row 4: only {b_code} prefers the swap room"

    return False, "rows 5-7 default: no preference distinguishes the doctors"
    # (row 5 dropped -- see module docstring; rows 6/7 were already default)
