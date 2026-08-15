"""Phases 7-9A -- resolve remaining REQUIRES_ROOM slots after Phase 5.

Three passes over every doctor whose REQUIRES_ROOM slot still has
`assigned_room_id is None`:

  Pass 1 (full-day Trainee/AHP): a Trainee/AHP needing the same D room for
    both AM and PM of a day. Prefer a room free in both sessions; failing
    that, displace a full-day Partner/Salaried D-room occupant. Victims are
    ranked in two priority tiers ahead of any tie-break: Priority 1 is a
    doctor holding a *different* D room in AM and PM (displacing them frees
    two D rooms for one move); Priority 2 is a doctor holding the *same* D
    room all day. Within a tier, ties are broken on live weighted
    room-move score, then doctor code. The displaced doctor is relocated
    from a fixed C/W/SR pool only -- Pass 1 never consults their own
    preference list (see `_pass1_receiving_room`). When a Priority 1
    victim is displaced, both of their D rooms are checked for same-day
    consolidation before the trainee is split across them: if either room
    turns out to already be free in the other session, the trainee takes
    that one room for the full day instead of being split.
  Pass 2 (single-session Trainee/AHP): the same, per remaining individual
    session -- covers slots Pass 1 couldn't resolve as a full day, and
    slots that only ever needed a single session. Victims are ranked by
    priority tier first: Priority 1 is a doctor whose other session has no
    room setup to fragment (absent, on leave, or roomless); Priority 2 is a
    doctor holding a *different* room in the other session; Priority 3 is a
    doctor holding the same D room all day. Within a tier, ties are broken
    on live weighted room-move score, then doctor code. A doctor displaced
    in AM reclassifies from tier 3 to tier 2 for PM (their AM room no
    longer matches the D room), so the same doctor may be bumped twice in
    one day -- this is accepted as consistent with the tiering principle,
    not a bug.
  Pass 3 (Partner/Salaried fallback): no displacement -- walk the doctor's
    own preference list first; if nothing on it is free, force the doctor
    into the first free room by type priority D > C > W > SR (rooms
    ordered by code within a type). Only if every room in the practice is
    occupied does the slot remain unresolved.

Displacing a Partner/Salaried doctor in Pass 2 follows the full "Room
Preference Assignment" algorithm from algorithms.md: preferred list first,
then any free room of an eligible non-D type (C, W, SR) as a fallback.
Pass 1 skips the preference-list step and goes straight to the C/W/SR pool
(see above) -- this asymmetry between Pass 1 and Pass 2 is deliberate, not
an inconsistency. Pass 3 has its own, separate fallback: D/C/W/SR by type
priority, with D rooms deliberately included. This is a genuine, intended
difference from the Pass 1/2 displaced-doctor pool (C/W/SR, D excluded) --
Pass 3 runs last, after all Trainee/AHP D-room demand has already been
settled by Passes 1 and 2, so any D room still free at this point is
surplus and safe to hand to a Partner/Salaried doctor.

Known gap, flagged for Phase 12 (next step): a doctor on leave still gets a
REQUIRES_ROOM `SessionSlot` from Phase 2 (the template says they'd need a
room if working), but this module skips leave slots entirely -- they never
get a room and are not treated as failures. Phase 12 Check 3 ("no
unresolved REQUIRES_ROOM slot") must exclude on-leave slots too, or every
leave day will read as a validation failure.
"""
from __future__ import annotations

from ...models.enums import (
    Day,
    DoctorType,
    MasterSessionType,
    Period,
    RoomType,
    SystemCounterType,
)
from .. import rationale as rat
from ..datatypes import CounterState, DecisionLog, GenerationContext, RotaGrid, ValidationIssue
from ..room_relocation import find_relocation_room

PHASE = "phase7_9a"

_DAYS = (Day.MONDAY, Day.TUESDAY, Day.WEDNESDAY, Day.THURSDAY, Day.FRIDAY)
_PERIODS = (Period.AM, Period.PM)
_DISPLACEABLE_TYPES = (DoctorType.PARTNER, DoctorType.SALARIED)
# Doctor types that need a D room (Passes 1 and 2). Locum behaves as
# Trainee-minus-supervision (same D-room priority, eligible for supervision
# assignment) -- it is added here alongside Trainee/AHP so the two candidate
# functions below cannot drift.
_D_ROOM_TYPES = (DoctorType.TRAINEE, DoctorType.AHP, DoctorType.LOCUM)
_ROOM_MOVE_FALLBACK_TYPES = (RoomType.C, RoomType.W, RoomType.SR)

# Pass 3's own fallback order -- deliberately its own type sequence, not a
# reuse of _ROOM_MOVE_FALLBACK_TYPES. D rooms are included here (unlike the
# Pass 1/2 displaced-doctor pool above) because Pass 3 runs last, after all
# Trainee/AHP D-room demand has already been resolved by Passes 1 and 2, so
# any D room still free at this point is genuine surplus.
_PASS3_FALLBACK_TYPE_ORDER = (RoomType.D, RoomType.C, RoomType.W, RoomType.SR)


def run_phase7_to_9a(
    context: GenerationContext, grid: RotaGrid, counters: CounterState, log: DecisionLog
) -> list[ValidationIssue]:
    issues: list[ValidationIssue] = []
    num_weeks = max((gw for gw, _day in context.week_dates.keys()), default=0)
    d_room_ids = sorted(r.id for r in context.rooms_by_type.get(RoomType.D, ()))

    for gen_week in range(1, num_weeks + 1):
        for day in _DAYS:
            issues.extend(_pass1_full_day(context, grid, counters, gen_week, day, d_room_ids, log))

    for gen_week in range(1, num_weeks + 1):
        for day in _DAYS:
            for period in _PERIODS:
                issues.extend(
                    _pass2_single_session(context, grid, counters, gen_week, day, period, d_room_ids, log)
                )

    for gen_week in range(1, num_weeks + 1):
        for day in _DAYS:
            for period in _PERIODS:
                issues.extend(_pass3_partner_salaried_fallback(context, grid, gen_week, day, period, log))

    return issues


# ---------------------------------------------------------------------------
# Pass 1: full-day Trainee/AHP
# ---------------------------------------------------------------------------

def _pass1_full_day(
    context: GenerationContext, grid: RotaGrid, counters: CounterState,
    gen_week: int, day: Day, d_room_ids: list[int], log: DecisionLog,
) -> list[ValidationIssue]:
    issues: list[ValidationIssue] = []
    candidates = _full_day_candidates(context, grid, gen_week, day)

    for doctor_id in candidates:
        am_slot = grid.get(doctor_id, gen_week, day, Period.AM)
        pm_slot = grid.get(doctor_id, gen_week, day, Period.PM)
        if am_slot.assigned_room_id is not None or pm_slot.assigned_room_id is not None:
            continue  # already resolved earlier in this pass

        rooms_line = rat.listing(
            "D rooms across the whole day (room-id order, the search order)",
            _d_room_states_day(context, grid, gen_week, day, d_room_ids),
        )

        free_room = _first_free_room_both(grid, gen_week, day, d_room_ids)
        if free_room is not None:
            grid.assign_room(gen_week, day, Period.AM, doctor_id, free_room)
            grid.assign_room(gen_week, day, Period.PM, doctor_id, free_room)
            log.add(
                phase=PHASE, action="assign_room",
                week=gen_week, day=day, period=None, doctor_id=doctor_id,
                room_id=free_room,
                message=(
                    f"Assigned D room {context.room_by_id[free_room].code} to "
                    f"{_code(context, doctor_id)} for the full day (pass 1, "
                    f"room free both sessions)."
                ),
                rationale=rat.stages(
                    f"{_code(context, doctor_id)} is "
                    f"{context.doctor_by_id[doctor_id].doctor_type.value} and needs "
                    f"a D room for both sessions of {day.value}.",
                    rooms_line,
                    rat.decided(
                        f"first D room free in both sessions -- "
                        f"{context.room_by_id[free_room].code}; nobody was displaced"
                    ),
                ),
            )
            continue

        candidate, victim_pool = _find_full_day_displacement(
            context, grid, counters, gen_week, day
        )
        victims_line = rat.listing(
            "Displaceable full-day D-room holders (Partner/Salaried, role-free, "
            "not on leave), by priority tier then weighted room-move counter",
            [
                f"{_code(context, cand_id)} (tier {tier}: "
                + (
                    f"holds {context.room_by_id[am].code} AM and "
                    f"{context.room_by_id[pm].code} PM, so displacing them frees two "
                    f"D rooms" if tier == 1 else
                    f"holds {context.room_by_id[am].code} all day"
                )
                + f", {_room_move_score_text(context, counters, cand_id)})"
                for tier, cand_id, am, pm in victim_pool
            ],
        )
        if candidate is None:
            issues.append(_warning(
                "no_full_day_room", gen_week, day, None,
                f"No free or displaceable D room for {_code(context, doctor_id)} "
                f"(full day) on {day.value}.",
            ))
            log.add(
                phase=PHASE, action="no_full_day_room",
                week=gen_week, day=day, period=None, doctor_id=doctor_id,
                message=(
                    f"No free or displaceable D room for "
                    f"{_code(context, doctor_id)} (full day) on {day.value}; "
                    f"left for pass 2."
                ),
                rationale=rat.stages(
                    rooms_line,
                    "No D room was free in both sessions, so a full-day victim was "
                    "sought.",
                    victims_line,
                    rat.decided(
                        "nothing left to try in this pass -- no Partner/Salaried "
                        "doctor held a D room all day while free of a role and of "
                        "leave"
                    ),
                ),
            )
            continue

        displaced_id, am_room, pm_room = candidate
        tier = 1 if am_room != pm_room else 2

        new_room = _pass1_receiving_room(context, grid, gen_week, day)
        if new_room is None:
            issues.append(_warning(
                "no_full_day_room", gen_week, day, None,
                f"Could not relocate {_code(context, displaced_id)} to free a D "
                f"room for {_code(context, doctor_id)} (full day) on {day.value}.",
            ))
            log.add(
                phase=PHASE, action="no_full_day_room",
                week=gen_week, day=day, period=None, doctor_id=doctor_id,
                related_doctor_id=displaced_id,
                message=(
                    f"Could not relocate {_code(context, displaced_id)} to free a "
                    f"D room for {_code(context, doctor_id)} (full day) on "
                    f"{day.value}; left for pass 2."
                ),
                rationale=rat.stages(
                    rooms_line,
                    victims_line,
                    f"{_code(context, displaced_id)} was chosen as the victim "
                    f"({_victim_decisive(context, counters, victim_pool, displaced_id)}).",
                    rat.decided(
                        "abandoned -- pass 1 rehouses a victim only into a C/W/SR "
                        "room free in both sessions (their own preference list is "
                        "deliberately not consulted here), and none was; the "
                        "displacement was rolled back rather than half-applied"
                    ),
                ),
            )
            continue

        # Decide the trainee's room(s) before moving the victim, while the
        # victim still occupies both rooms: "free in the other session
        # now" is exactly "free all day once the victim leaves". Priority
        # 2 (am_room == pm_room) is trivially the single-room case.
        if am_room == pm_room:
            outcome = "single"
        elif grid.is_room_free(gen_week, day, Period.PM, am_room):
            outcome = "consolidated_am"
        elif grid.is_room_free(gen_week, day, Period.AM, pm_room):
            outcome = "consolidated_pm"
        else:
            outcome = "split"

        tier_desc = f"priority tier {tier}, tie broken on weighted room-move score"
        victim_rationale = rat.stages(
            f"{_code(context, doctor_id)} is "
            f"{context.doctor_by_id[doctor_id].doctor_type.value} and needs a D room "
            f"for both sessions of {day.value}.",
            rooms_line,
            "No D room was free in both sessions, so a full-day victim was sought.",
            victims_line,
            f"Receiving room for the victim: "
            f"{context.room_by_id[new_room].code} -- the first C/W/SR room free in "
            f"both sessions (pass 1 does not consult the victim's own preference "
            f"list).",
            rat.decided(_victim_decisive(context, counters, victim_pool, displaced_id)),
        )

        # Move the displaced doctor first -- assign_room re-points the
        # occupancy indexes, freeing their old room(s) -- then place the
        # trainee. The room-move counter is incremented exactly once per
        # displacement regardless of how the trainee ends up split.
        grid.assign_room(gen_week, day, Period.AM, displaced_id, new_room)
        grid.assign_room(gen_week, day, Period.PM, displaced_id, new_room)
        counters.increment_system(displaced_id, SystemCounterType.ROOM_MOVE)

        if outcome == "single":
            grid.assign_room(gen_week, day, Period.AM, doctor_id, am_room)
            grid.assign_room(gen_week, day, Period.PM, doctor_id, am_room)
            log.add(
                phase=PHASE, action="displace_room",
                week=gen_week, day=day, period=None, doctor_id=doctor_id,
                related_doctor_id=displaced_id, room_id=am_room, related_room_id=new_room,
                message=(
                    f"Displaced {_code(context, displaced_id)} from "
                    f"{context.room_by_id[am_room].code} to "
                    f"{context.room_by_id[new_room].code} to free the D room for "
                    f"{_code(context, doctor_id)} (full day, pass 1, {tier_desc})."
                ),
                rationale=victim_rationale,
            )
        elif outcome in ("consolidated_am", "consolidated_pm"):
            trainee_room = am_room if outcome == "consolidated_am" else pm_room
            grid.assign_room(gen_week, day, Period.AM, doctor_id, trainee_room)
            grid.assign_room(gen_week, day, Period.PM, doctor_id, trainee_room)
            log.add(
                phase=PHASE, action="displace_room",
                week=gen_week, day=day, period=None, doctor_id=doctor_id,
                related_doctor_id=displaced_id, room_id=trainee_room, related_room_id=new_room,
                message=(
                    f"Displaced {_code(context, displaced_id)} from "
                    f"{context.room_by_id[am_room].code}/{context.room_by_id[pm_room].code} "
                    f"to {context.room_by_id[new_room].code}, vacating both rooms for "
                    f"{_code(context, doctor_id)}, who consolidates into "
                    f"{context.room_by_id[trainee_room].code} for the full day "
                    f"(full day, pass 1, {tier_desc})."
                ),
                rationale=rat.stages(
                    victim_rationale,
                    f"The victim held two different D rooms, and "
                    f"{context.room_by_id[trainee_room].code} turned out to be free "
                    f"in the other session as well once they left, so "
                    f"{_code(context, doctor_id)} takes that one room all day rather "
                    f"than being split across both.",
                ),
            )
        else:  # split
            grid.assign_room(gen_week, day, Period.AM, doctor_id, am_room)
            grid.assign_room(gen_week, day, Period.PM, doctor_id, pm_room)
            log.add(
                phase=PHASE, action="displace_room",
                week=gen_week, day=day, period=Period.AM, doctor_id=doctor_id,
                related_doctor_id=displaced_id, room_id=am_room, related_room_id=new_room,
                message=(
                    f"Displaced {_code(context, displaced_id)} from "
                    f"{context.room_by_id[am_room].code}/{context.room_by_id[pm_room].code} "
                    f"to {context.room_by_id[new_room].code}; {_code(context, doctor_id)} "
                    f"takes {context.room_by_id[am_room].code} in AM (full day, pass 1, "
                    f"{tier_desc}; room-move counter incremented once for the day, "
                    f"covering both periods)."
                ),
                rationale=rat.stages(
                    victim_rationale,
                    f"The victim held two different D rooms and neither was free in "
                    f"the other session once they left, so "
                    f"{_code(context, doctor_id)} is split across both.",
                ),
            )
            log.add(
                phase=PHASE, action="displace_room",
                week=gen_week, day=day, period=Period.PM, doctor_id=doctor_id,
                related_doctor_id=displaced_id, room_id=pm_room, related_room_id=new_room,
                message=(
                    f"{_code(context, doctor_id)} takes "
                    f"{context.room_by_id[pm_room].code} in PM, completing the full-day "
                    f"split freed by displacing {_code(context, displaced_id)} "
                    f"(full day, pass 1, {tier_desc})."
                ),
                rationale=rat.stages(
                    victim_rationale,
                    "Second half of the same split; the room-move counter was "
                    "incremented once, on the AM entry, for the whole day.",
                ),
            )

    return issues


def _full_day_candidates(
    context: GenerationContext, grid: RotaGrid, gen_week: int, day: Day
) -> list[int]:
    result = []
    for doctor in context.doctors:  # already ordered by code
        if doctor.doctor_type not in _D_ROOM_TYPES:
            continue
        am_slot = grid.get(doctor.id, gen_week, day, Period.AM)
        pm_slot = grid.get(doctor.id, gen_week, day, Period.PM)
        if am_slot is None or pm_slot is None:
            continue
        if am_slot.is_on_leave or pm_slot.is_on_leave:
            continue
        if am_slot.template_type != MasterSessionType.REQUIRES_ROOM:
            continue
        if pm_slot.template_type != MasterSessionType.REQUIRES_ROOM:
            continue
        if am_slot.assigned_room_id is not None or pm_slot.assigned_room_id is not None:
            continue
        result.append(doctor.id)
    return result


def _find_full_day_displacement(
    context: GenerationContext, grid: RotaGrid, counters: CounterState,
    gen_week: int, day: Day,
) -> tuple[tuple[int, int, int] | None, list[tuple[int, int, int, int]]]:
    """Find the best full-day Partner/Salaried victim to displace.

    Candidates are Partner/Salaried doctors currently holding a D room in
    both AM and PM of `day`. Priority 1: the doctor holds a *different* D
    room in each session -- displacing them frees two D rooms for the
    price of one move. Priority 2: the doctor holds the *same* D room all
    day. Within a tier, ties are broken on live weighted room-move score,
    then doctor code.

    Returns `(best, pool)`. `best` is `(doctor_id, am_room_id, pm_room_id)`
    -- with `am_room_id == pm_room_id` for a Priority 2 candidate -- or
    `None` if no doctor qualifies. `pool` is the whole sorted candidate
    list as `(tier, doctor_id, am_room, pm_room)`, returned so the decision
    log can show the field the winner was picked from (and so an empty
    field explains a failure).
    """
    candidates: list[tuple[int, int, int, int]] = []  # (tier, doctor_id, am_room, pm_room)
    for doctor in context.doctors:  # already ordered by code
        if doctor.doctor_type not in _DISPLACEABLE_TYPES:
            continue
        am_room = grid.get_doctor_room(gen_week, day, Period.AM, doctor.id)
        pm_room = grid.get_doctor_room(gen_week, day, Period.PM, doctor.id)
        if am_room is None or pm_room is None:
            continue
        if context.room_by_id[am_room].room_type != RoomType.D:
            continue
        if context.room_by_id[pm_room].room_type != RoomType.D:
            continue
        if not _is_displaceable_full_day(context, grid, doctor.id, gen_week, day):
            continue
        tier = 1 if am_room != pm_room else 2
        candidates.append((tier, doctor.id, am_room, pm_room))

    candidates.sort(key=lambda c: (c[0], *_room_move_sort_key(context, counters, c[1])))
    if not candidates:
        return None, candidates

    best = candidates[0]
    return (best[1], best[2], best[3]), candidates


def _is_displaceable_full_day(
    context: GenerationContext, grid: RotaGrid, doctor_id: int, gen_week: int, day: Day
) -> bool:
    doctor = context.doctor_by_id.get(doctor_id)
    if doctor is None or doctor.doctor_type not in _DISPLACEABLE_TYPES:
        return False
    am_slot = grid.get(doctor_id, gen_week, day, Period.AM)
    pm_slot = grid.get(doctor_id, gen_week, day, Period.PM)
    if am_slot is None or pm_slot is None:
        return False
    if am_slot.is_on_leave or pm_slot.is_on_leave:
        return False
    if am_slot.role is not None or pm_slot.role is not None:
        return False
    return True


def _pass1_receiving_room(
    context: GenerationContext, grid: RotaGrid, gen_week: int, day: Day
) -> int | None:
    """Find a room to receive a doctor displaced by Pass 1.

    Pass 1 displacement never consults the displaced doctor's preference
    list -- the receiving room is the first eligible C/W/SR room, by id, that
    is free in both AM and PM of `day`. This search is victim-independent
    (no `doctor_id` parameter): the same room would be returned regardless of
    who is being displaced, since victim selection and receiving-room search
    are decoupled.

    Returns `None` if no pool room is free in both sessions.
    """
    fallback_ids = sorted(
        r.id for r in context.rooms if r.room_type in _ROOM_MOVE_FALLBACK_TYPES
    )
    return _first_free_room_both(grid, gen_week, day, fallback_ids)


# ---------------------------------------------------------------------------
# Pass 2: single-session Trainee/AHP
# ---------------------------------------------------------------------------

def _displacement_priority(
    grid: RotaGrid, doctor_id: int, gen_week: int, day: Day,
    period: Period, d_room_id: int,
) -> int:
    """Tier 1 = other session has no room setup to fragment; 2 = other
    session is in a different room anyway; 3 = same D room all day.

    The `is_on_leave` check is defensive ordering: a leave slot should
    never carry an `assigned_room_id` (Phase 2 skips the room claim for
    on-leave PRE_ASSIGNED slots), but leave must classify as tier 1
    regardless.
    """
    other = Period.PM if period == Period.AM else Period.AM
    other_slot = grid.get(doctor_id, gen_week, day, other)
    if other_slot is None or other_slot.is_on_leave or other_slot.assigned_room_id is None:
        return 1
    if other_slot.assigned_room_id != d_room_id:
        return 2
    return 3


def _pass2_single_session(
    context: GenerationContext, grid: RotaGrid, counters: CounterState,
    gen_week: int, day: Day, period: Period, d_room_ids: list[int], log: DecisionLog,
) -> list[ValidationIssue]:
    issues: list[ValidationIssue] = []
    candidates = _single_session_candidates(context, grid, gen_week, day, period)

    for doctor_id in candidates:
        slot = grid.get(doctor_id, gen_week, day, period)
        if slot.assigned_room_id is not None:
            continue  # defensive: pass 1 only ever resolves both sessions or neither

        rooms_line = rat.listing(
            f"D rooms in {period.value} (room-id order, the search order)",
            _d_room_states_period(context, grid, gen_week, day, period, d_room_ids),
        )
        need_line = (
            f"{_code(context, doctor_id)} is "
            f"{context.doctor_by_id[doctor_id].doctor_type.value} and needs a D room "
            f"for {day.value} {period.value}."
        )

        free_room = _first_free_room_single(grid, gen_week, day, period, d_room_ids)
        if free_room is not None:
            grid.assign_room(gen_week, day, period, doctor_id, free_room)
            log.add(
                phase=PHASE, action="assign_room",
                week=gen_week, day=day, period=period, doctor_id=doctor_id,
                room_id=free_room,
                message=(
                    f"Assigned D room {context.room_by_id[free_room].code} to "
                    f"{_code(context, doctor_id)} on {day.value} {period.value} "
                    f"(pass 2, room free)."
                ),
                rationale=rat.stages(
                    need_line,
                    rooms_line,
                    rat.decided(
                        f"first free D room -- "
                        f"{context.room_by_id[free_room].code}; nobody was displaced"
                    ),
                ),
            )
            continue

        candidate, victim_pool = _find_single_session_displacement(
            context, grid, counters, gen_week, day, period, d_room_ids,
        )
        victims_line = rat.listing(
            "Displaceable D-room occupants (Partner/Salaried, role-free, not on "
            "leave), by priority tier then weighted room-move counter",
            [
                f"{_code(context, cand_id)} in {context.room_by_id[room].code} "
                f"(tier {tier_}: {_TIER_MEANINGS[tier_]}, "
                f"{_room_move_score_text(context, counters, cand_id)})"
                for tier_, cand_id, room in victim_pool
            ],
        )
        if candidate is None:
            issues.append(_warning(
                "no_single_session_room", gen_week, day, period,
                f"No free or displaceable D room for {_code(context, doctor_id)} "
                f"on {day.value} {period.value}.",
            ))
            log.add(
                phase=PHASE, action="no_single_session_room",
                week=gen_week, day=day, period=period, doctor_id=doctor_id,
                message=(
                    f"No free or displaceable D room for "
                    f"{_code(context, doctor_id)} on {day.value} {period.value}; "
                    f"slot left without a room."
                ),
                rationale=rat.stages(
                    need_line,
                    rooms_line,
                    victims_line,
                    rat.decided(
                        "nothing left to try -- every D room was held by someone "
                        "who could not be displaced (not Partner/Salaried, on "
                        "leave, or already holding a role)"
                    ),
                ),
            )
            continue

        displaced_id, d_room_id, tier = candidate
        new_room = find_relocation_room(
            context, grid, displaced_id, gen_week, day, period,
        )
        if new_room is None:
            issues.append(_warning(
                "no_single_session_room", gen_week, day, period,
                f"Could not relocate {_code(context, displaced_id)} to free a D "
                f"room for {_code(context, doctor_id)} on {day.value} {period.value}.",
            ))
            log.add(
                phase=PHASE, action="no_single_session_room",
                week=gen_week, day=day, period=period, doctor_id=doctor_id,
                related_doctor_id=displaced_id, room_id=d_room_id,
                message=(
                    f"Could not relocate {_code(context, displaced_id)} to free "
                    f"{context.room_by_id[d_room_id].code} for "
                    f"{_code(context, doctor_id)} on {day.value} {period.value}; "
                    f"slot left without a room."
                ),
                rationale=rat.stages(
                    need_line,
                    rooms_line,
                    victims_line,
                    f"{_code(context, displaced_id)} was chosen as the victim "
                    f"({_victim_decisive(context, counters, victim_pool, displaced_id)}).",
                    rat.decided(
                        "abandoned -- no room on their preference list, and no free "
                        "C/W/SR room, was available to rehouse them, so the "
                        "displacement was rolled back rather than half-applied"
                    ),
                ),
            )
            continue

        grid.assign_room(gen_week, day, period, displaced_id, new_room)
        grid.assign_room(gen_week, day, period, doctor_id, d_room_id)
        counters.increment_system(displaced_id, SystemCounterType.ROOM_MOVE)
        log.add(
            phase=PHASE, action="displace_room",
            week=gen_week, day=day, period=period, doctor_id=doctor_id,
            related_doctor_id=displaced_id, room_id=d_room_id, related_room_id=new_room,
            message=(
                f"Displaced {_code(context, displaced_id)} from "
                f"{context.room_by_id[d_room_id].code} to "
                f"{context.room_by_id[new_room].code} to free the D room for "
                f"{_code(context, doctor_id)} on {day.value} {period.value} "
                f"(pass 2, selected on priority tier {tier}, tie broken on "
                f"weighted room-move score)."
            ),
            rationale=rat.stages(
                need_line,
                rooms_line,
                "No D room was free, so a victim was sought.",
                victims_line,
                rat.decided(
                    _victim_decisive(context, counters, victim_pool, displaced_id)
                ),
                f"{_code(context, displaced_id)} was rehoused in "
                f"{context.room_by_id[new_room].code} (first free room on their own "
                f"preference list, else the first free C/W/SR room) and their "
                f"room-move counter was incremented.",
            ),
        )

    return issues


def _single_session_candidates(
    context: GenerationContext, grid: RotaGrid, gen_week: int, day: Day, period: Period
) -> list[int]:
    result = []
    for doctor in context.doctors:
        if doctor.doctor_type not in _D_ROOM_TYPES:
            continue
        slot = grid.get(doctor.id, gen_week, day, period)
        if slot is None or slot.is_on_leave:
            continue
        if slot.template_type != MasterSessionType.REQUIRES_ROOM:
            continue
        if slot.assigned_room_id is not None:
            continue
        result.append(doctor.id)
    return result


def _find_single_session_displacement(
    context: GenerationContext, grid: RotaGrid, counters: CounterState,
    gen_week: int, day: Day, period: Period, d_room_ids: list[int],
) -> tuple[tuple[int, int, int] | None, list[tuple[int, int, int]]]:
    """`(best, pool)`. `best` is `(doctor_id, d_room_id, tier)` or `None`;
    `pool` is the whole sorted field as `(tier, doctor_id, d_room_id)`, for
    the decision log."""
    candidates: list[tuple[int, int]] = []
    for room_id in d_room_ids:
        occ = grid.get_room_occupant(gen_week, day, period, room_id)
        if occ is None:
            continue
        if not _is_displaceable_single(context, grid, occ, gen_week, day, period):
            continue
        candidates.append((occ, room_id))

    candidates.sort(key=lambda c: (
        _displacement_priority(grid, c[0], gen_week, day, period, c[1]),
        *_room_move_sort_key(context, counters, c[0]),
    ))
    pool = [
        (_displacement_priority(grid, doctor_id, gen_week, day, period, room_id),
         doctor_id, room_id)
        for doctor_id, room_id in candidates
    ]
    if not pool:
        return None, pool

    tier, doctor_id, room_id = pool[0]
    return (doctor_id, room_id, tier), pool


def _is_displaceable_single(
    context: GenerationContext, grid: RotaGrid, doctor_id: int,
    gen_week: int, day: Day, period: Period,
) -> bool:
    doctor = context.doctor_by_id.get(doctor_id)
    if doctor is None or doctor.doctor_type not in _DISPLACEABLE_TYPES:
        return False
    slot = grid.get(doctor_id, gen_week, day, period)
    if slot is None or slot.is_on_leave or slot.role is not None:
        return False
    return True


# ---------------------------------------------------------------------------
# Pass 3: Partner/Salaried fallback (no displacement)
# ---------------------------------------------------------------------------

def _pass3_partner_salaried_fallback(
    context: GenerationContext, grid: RotaGrid, gen_week: int, day: Day, period: Period,
    log: DecisionLog,
) -> list[ValidationIssue]:
    issues: list[ValidationIssue] = []
    fallback_sequence = _pass3_fallback_sequence(context)

    for doctor in context.doctors:
        if doctor.doctor_type not in _DISPLACEABLE_TYPES:
            continue
        slot = grid.get(doctor.id, gen_week, day, period)
        if slot is None or slot.is_on_leave:
            continue
        if slot.template_type != MasterSessionType.REQUIRES_ROOM:
            continue
        if slot.assigned_room_id is not None:
            continue

        chosen = None
        is_fallback = False
        preferred = context.preferred_rooms_by_doctor.get(doctor.id, ())
        for room_id in preferred:
            if grid.is_room_free(gen_week, day, period, room_id):
                chosen = room_id
                break

        preference_line = rat.listing(
            f"{doctor.code}'s preferred rooms, in their stated order",
            [_room_state(context, grid, gen_week, day, period, rid) for rid in preferred],
        )

        if chosen is None:
            for room_id in fallback_sequence:
                if grid.is_room_free(gen_week, day, period, room_id):
                    chosen = room_id
                    is_fallback = True
                    break

        if chosen is None:
            issues.append(_warning(
                "no_partner_salaried_room", gen_week, day, period,
                f"No free room anywhere for {doctor.code} on {day.value} "
                f"{period.value}; slot remains unresolved.",
            ))
            log.add(
                phase=PHASE, action="no_partner_salaried_room",
                week=gen_week, day=day, period=period, doctor_id=doctor.id,
                message=(
                    f"No free room anywhere for {doctor.code} on {day.value} "
                    f"{period.value}; slot remains unresolved."
                ),
                rationale=rat.stages(
                    preference_line,
                    "Nothing on that list was free, and pass 3 never displaces "
                    "anyone, so the forced fallback (every room, by type priority "
                    "D > C > W > SR) was tried next.",
                    rat.decided(
                        "nothing left to try -- every room in the practice was "
                        "occupied this session"
                    ),
                ),
            )
            continue

        grid.assign_room(gen_week, day, period, doctor.id, chosen)
        if is_fallback:
            message = (
                f"Assigned fallback room {context.room_by_id[chosen].code} to "
                f"{doctor.code} (pass 3, no preferred room free; forced into "
                f"first free room by type priority D > C > W > SR)."
            )
            entry_rationale = rat.stages(
                preference_line,
                "Nothing on that list was free, and pass 3 never displaces anyone.",
                rat.decided(
                    f"forced fallback -- {context.room_by_id[chosen].code} is the "
                    f"first free room by type priority D > C > W > SR (D rooms are "
                    f"included here because passes 1 and 2 have already taken every "
                    f"D room the Trainees/AHPs needed)"
                ),
            )
        else:
            message = (
                f"Assigned preferred room {context.room_by_id[chosen].code} to "
                f"{doctor.code} (pass 3, first free room on preference list)."
            )
            entry_rationale = rat.stages(
                preference_line,
                rat.decided(
                    f"{rat.PREFERENCE_ORDER} -- "
                    f"{context.room_by_id[chosen].code} was the first free room on it"
                ),
            )
        log.add(
            phase=PHASE, action="assign_room",
            week=gen_week, day=day, period=period, doctor_id=doctor.id,
            room_id=chosen,
            message=message,
            rationale=entry_rationale,
        )

    return issues


def _pass3_fallback_sequence(context: GenerationContext) -> list[int]:
    """Room ids in Pass 3's forced-fallback order: D, then C, then W, then
    SR, sorted by code within each type. Built once per call of
    `_pass3_partner_salaried_fallback` -- it depends only on `context`, not
    on the grid, so it does not need rebuilding per doctor or per room
    check.
    """
    sequence: list[int] = []
    for room_type in _PASS3_FALLBACK_TYPE_ORDER:
        rooms = sorted(context.rooms_by_type.get(room_type, ()), key=lambda r: r.code)
        sequence.extend(r.id for r in rooms)
    return sequence


# ---------------------------------------------------------------------------
# Shared helpers
# ---------------------------------------------------------------------------

def _first_free_room_both(grid: RotaGrid, gen_week: int, day: Day, room_ids: list[int]) -> int | None:
    for room_id in room_ids:
        if grid.is_room_free(gen_week, day, Period.AM, room_id) and \
           grid.is_room_free(gen_week, day, Period.PM, room_id):
            return room_id
    return None


def _first_free_room_single(
    grid: RotaGrid, gen_week: int, day: Day, period: Period, room_ids: list[int]
) -> int | None:
    for room_id in room_ids:
        if grid.is_room_free(gen_week, day, period, room_id):
            return room_id
    return None


def _room_move_sort_key(context: GenerationContext, counters: CounterState, doctor_id: int):
    spw = context.spw_by_id.get(doctor_id, 0.0)
    score = counters.weighted_system_score(doctor_id, SystemCounterType.ROOM_MOVE, spw)
    code = context.doctor_by_id[doctor_id].code
    return (score, code)


# What each Pass 2 displacement tier means, for the decision log. Keyed to
# `_displacement_priority`'s return values, which is the only thing that
# may define them.
_TIER_MEANINGS = {
    1: "other session has no room setup to fragment",
    2: "other session is in a different room anyway",
    3: "same D room all day, so displacing them fragments their day",
}


def _room_move_score_text(
    context: GenerationContext, counters: CounterState, doctor_id: int
) -> str:
    spw = context.spw_by_id.get(doctor_id, 0.0)
    raw = counters.system.get((doctor_id, SystemCounterType.ROOM_MOVE), 0)
    return rat.score(
        raw, spw, counters.weighted_system_score(doctor_id, SystemCounterType.ROOM_MOVE, spw)
    )


def _victim_decisive(
    context: GenerationContext, counters: CounterState,
    pool: list, chosen_id: int,
) -> str:
    """Name the stage that actually picked `chosen_id` out of `pool`.

    Shared by Passes 1 and 2: both rank victims by priority tier, then live
    weighted room-move score, then doctor code, so both explain themselves
    the same way. `pool` entries are `(tier, doctor_id, ...)` in either
    pass's shape; only the first two positions are read.
    """
    chosen_code = _code(context, chosen_id)
    if len(pool) == 1:
        return f"{rat.ONLY_CANDIDATE} -- {chosen_code}"

    tier = next(entry[0] for entry in pool if entry[1] == chosen_id)
    same_tier = [entry for entry in pool if entry[0] == tier]
    if len(same_tier) == 1:
        return (
            f"{rat.PRIORITY_TIER} -- {chosen_code} is alone in tier {tier} "
            f"({_TIER_MEANINGS.get(tier, 'see the pass description')})"
        )

    best = _room_move_sort_key(context, counters, chosen_id)[0]
    tied = [
        entry for entry in same_tier
        if _room_move_sort_key(context, counters, entry[1])[0] == best
    ]
    if len(tied) == 1:
        return (
            f"{rat.WEIGHTED_COUNTER} -- inside tier {tier}, {chosen_code} has the "
            f"lowest weighted room-move score, {rat.fmt(best)}"
        )
    return (
        f"{rat.ALPHABETICAL} -- {chosen_code}, tied inside tier {tier} on a weighted "
        f"room-move score of {rat.fmt(best)}"
    )


def _room_state(
    context: GenerationContext, grid: RotaGrid,
    gen_week: int, day: Day, period: Period, room_id: int,
) -> str:
    occupant_id = grid.get_room_occupant(gen_week, day, period, room_id)
    room_code = context.room_by_id[room_id].code
    if occupant_id is None:
        return f"{room_code}: free"
    return f"{room_code}: held by {_code(context, occupant_id)}"


def _d_room_states_period(
    context: GenerationContext, grid: RotaGrid,
    gen_week: int, day: Day, period: Period, d_room_ids: list[int],
) -> list[str]:
    return [
        _room_state(context, grid, gen_week, day, period, room_id)
        for room_id in d_room_ids
    ]


def _d_room_states_day(
    context: GenerationContext, grid: RotaGrid,
    gen_week: int, day: Day, d_room_ids: list[int],
) -> list[str]:
    """AM and PM state of each D room -- Pass 1 needs a room free in both,
    so a per-period view alone would not explain its choices."""
    states = []
    for room_id in d_room_ids:
        room_code = context.room_by_id[room_id].code
        parts = []
        for period in _PERIODS:
            occupant_id = grid.get_room_occupant(gen_week, day, period, room_id)
            parts.append(
                f"{period.value} free" if occupant_id is None
                else f"{period.value} held by {_code(context, occupant_id)}"
            )
        states.append(f"{room_code}: " + ", ".join(parts))
    return states


def _code(context: GenerationContext, doctor_id: int) -> str:
    doctor = context.doctor_by_id.get(doctor_id)
    return doctor.code if doctor is not None else f"id={doctor_id}"


def _warning(check: str, week: int, day: Day, period: Period | None, message: str) -> ValidationIssue:
    return ValidationIssue(
        severity="warning", phase=PHASE, check=check,
        week=week, day=day, period=period, message=message,
    )