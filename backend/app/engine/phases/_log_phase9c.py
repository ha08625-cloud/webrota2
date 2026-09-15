"""Decision-log narration for Phase 9C (trainee supervision).

The question this narration exists to answer is "why is this doctor never
picked to supervise", and the answer is usually the supervision-preference
multiplier. So the pool listing shows every doctor's raw count, their
sessions per week, their preference multiplier and the score that came
out, rather than only the final number -- and `_ineligible_lines` accounts
for every Partner/Salaried doctor in the session who is not in the pool at
all.

`supervision_score` lives here because the selection sort and its
explanation must read the same numbers; `phase9c.py` imports it back for
its sort key. `PREFERENCE_MULTIPLIERS` itself now lives in
`engine/preference.py`, shared with the WFH preference, and is re-exported
from here so that both the sort and the narration keep reading the one
table through a single name.

Timing matters in one place: both accounts of a selection are built
*before* the winner's supervision counter is incremented. Incrementing
first would show the winner's post-assignment score, which can read as
higher than the runner-up's -- i.e. as though the wrong doctor had been
picked.
"""
from __future__ import annotations

from ...models.enums import (
    Day,
    Period,
    SystemCounterType,
)
from .. import rationale as rat
from ..datatypes import (
    CounterState,
    DecisionLog,
    GenerationContext,
    RotaGrid,
    SessionSlot,
)
# Imported (and re-exported via __all__) rather than defined here, so the
# sort key and this narration read one table -- see the module docstring.
# It applies to every pool candidate now that there is no SR-priority fast
# path to exempt.
from ..preference import PREFERENCE_MULTIPLIERS

# Owned here rather than in `phase9c.py` so the narration can stamp it
# without importing its caller; the phase imports it back from here.
PHASE = "phase9c"


def supervision_score(
    context: GenerationContext, counters: CounterState, doctor_id: int,
    apply_preference: bool = True,
) -> float:
    """The score the pool is sorted by. `apply_preference=False` gives the
    same score with the multiplier removed, which is how the narration
    tells whether the preference is what flipped the outcome."""
    doctor = context.doctor_by_id[doctor_id]
    multiplier = (
        PREFERENCE_MULTIPLIERS[doctor.supervision_preference] if apply_preference else 1.0
    )
    return counters.weighted_system_score(
        doctor_id, SystemCounterType.SUPERVISION,
        context.spw_by_id.get(doctor_id, 0.0), multiplier,
    )


def _selection_reason(
    context: GenerationContext, counters: CounterState, pool: list[SessionSlot],
) -> str:
    """Describe why `pool[0]` was picked over the field, mirroring Phase 5's
    `_selection_reason` but keyed on the SUPERVISION system counter -- the
    pool has no priority-tier concept, so this only ever compares scores.

    If the preference multiplier changed the outcome (the raw, unweighted
    scores would have picked someone else), the message says so explicitly,
    so the generation log never disagrees with what actually happened.
    """
    if len(pool) == 1:
        return "only eligible doctor"

    a, b = pool[0], pool[1]
    score_a = supervision_score(context, counters, a.doctor_id)
    score_b = supervision_score(context, counters, b.doctor_id)
    if score_a == score_b:
        return "alphabetical tie-break"

    raw_a = supervision_score(context, counters, a.doctor_id, False)
    raw_b = supervision_score(context, counters, b.doctor_id, False)
    # a is the winner post-multiplier (score_a < score_b, checked above). If
    # a's raw (unweighted) score was actually higher than b's, the raw order
    # would have picked b -- the multiplier is what flipped the outcome.
    suffix = " (preference-adjusted)" if raw_a > raw_b else ""
    return f"lowest weighted supervision score {score_a:.2f} vs {score_b:.2f}{suffix}"


def _pool_rationale(
    context: GenerationContext, counters: CounterState, grid: RotaGrid,
    pool: list[SessionSlot], trainee_count: int,
    week: int, day: Day, period: Period,
) -> str:
    """The full account of a supervision assignment: the pool with each
    doctor's raw count, sessions-per-week, preference multiplier and
    resulting score; who was excluded from the pool and why; and the stage
    that decided.

    There is no priority-tier stage here -- the pool is flat by design (see
    decision 2 in `phase9c`'s module docstring) -- so the account goes
    straight from the field to the counter comparison. The preference
    multiplier is shown per doctor rather than only when it changes the
    outcome, because "why is this doctor never picked" is usually answered
    by a `none` preference.
    """
    chosen = pool[0]
    chosen_code = context.doctor_by_id[chosen.doctor_id].code

    def _line(slot: SessionSlot) -> str:
        doctor = context.doctor_by_id[slot.doctor_id]
        spw = context.spw_by_id.get(slot.doctor_id, 0.0)
        raw = counters.system.get((slot.doctor_id, SystemCounterType.SUPERVISION), 0)
        balance = counters.system_opening_balance(
            slot.doctor_id, SystemCounterType.SUPERVISION
        )
        multiplier = PREFERENCE_MULTIPLIERS[doctor.supervision_preference]
        unweighted = supervision_score(context, counters, slot.doctor_id, False)
        # No room is named: Phase 9C now runs before the room passes, so a
        # pool candidate is roomless in all but the PRE_ASSIGNED case, and
        # the room they end up in is the SR room this phase books for them.
        return (
            f"{doctor.code}: "
            f"{rat.score(raw, spw, unweighted, balance)}"
            f", supervision preference {doctor.supervision_preference.value} "
            f"(x{multiplier:g}) -> "
            f"{rat.fmt(supervision_score(context, counters, slot.doctor_id))}"
        )

    lines: list[str | None] = [
        f"{trainee_count} trainee(s) in this session need supervision.",
        rat.listing(
            "Eligible pool (Partner/Salaried, role-free), by weighted "
            "supervision counter",
            [_line(slot) for slot in pool],
        ),
    ]
    ineligible = _ineligible_lines(context, grid, week, day, period)
    if ineligible:
        lines.append(rat.listing("Not in the pool", ineligible))

    if len(pool) == 1:
        lines.append(rat.decided(f"{rat.ONLY_CANDIDATE} -- {chosen_code}"))
        return rat.stages(*lines)

    best = supervision_score(context, counters, chosen.doctor_id)
    tied = [s for s in pool if supervision_score(context, counters, s.doctor_id) == best]
    if len(tied) > 1:
        lines.append(rat.listing(
            f"Tied on a weighted score of {rat.fmt(best)}",
            [context.doctor_by_id[s.doctor_id].code for s in tied],
        ))
        lines.append(rat.decided(f"{rat.ALPHABETICAL} -- {chosen_code}"))
        return rat.stages(*lines)

    runner_up = pool[1]
    raw_flip = (
        supervision_score(context, counters, chosen.doctor_id, False)
        > supervision_score(context, counters, runner_up.doctor_id, False)
    )
    lines.append(rat.decided(
        f"{rat.WEIGHTED_COUNTER} -- {chosen_code} has the lowest weighted "
        f"supervision score, {rat.fmt(best)}, against "
        f"{rat.fmt(supervision_score(context, counters, runner_up.doctor_id))} for "
        f"{context.doctor_by_id[runner_up.doctor_id].code}"
        + (
            "; note the supervision-preference multipliers flipped this -- on raw "
            "counts alone the runner-up would have been picked"
            if raw_flip else ""
        )
    ))
    return rat.stages(*lines)


def _ineligible_lines(
    context: GenerationContext, grid: RotaGrid, week: int, day: Day, period: Period,
) -> list[str]:
    """`(code, why)` lines for every Partner/Salaried doctor in the session
    who is *not* in the supervision pool.

    Mirrors `is_selectable_supervisor`'s criteria in the same order -- the
    pool predicate, which has no room criterion. It has to restate them
    rather than call it, since that predicate returns a bare bool -- the
    pairing is asserted by the tests, so a new criterion there without one
    here will fail rather than silently produce a doctor listed with the
    wrong reason.
    """
    # Deferred: `phase9c` imports this module, so the selection predicate
    # cannot be pulled in at import time. It is imported rather than
    # restated because "who is in the pool" must be the phase's own answer.
    from .phase9c import _SUPERVISOR_TYPES, is_selectable_supervisor

    lines = []
    for slot in sorted(
        grid.sessions_for_slot(week, day, period),
        key=lambda s: context.doctor_by_id[s.doctor_id].code
        if s.doctor_id in context.doctor_by_id else "",
    ):
        doctor = context.doctor_by_id.get(slot.doctor_id)
        if doctor is None or doctor.doctor_type not in _SUPERVISOR_TYPES:
            continue  # never a supervisor candidate; not worth a line each
        if is_selectable_supervisor(context, grid, slot):
            continue
        if slot.role is not None:
            why = f"already on {slot.role.value} this session"
        elif slot.is_on_leave:
            why = "on leave"
        elif slot.is_wfh:
            why = "working from home"
        else:
            why = f"template session is {slot.template_type.value}"
        lines.append(f"{doctor.code}: {why}")
    return lines


# ---------------------------------------------------------------------------
# Entries
# ---------------------------------------------------------------------------

def no_eligible_supervisor(
    log: DecisionLog, context: GenerationContext, grid: RotaGrid,
    gen_week: int, day: Day, period: Period, trainee_count: int,
) -> None:
    log.add(
        phase=PHASE, action="supervision_unassignable",
        week=gen_week, day=day, period=period,
        message=(
            f"No eligible supervisor on {day.value} {period.value} "
            f"for {trainee_count} trainee(s); session left unsupervised."
        ),
        rationale=rat.stages(
            f"{trainee_count} trainee(s) in this session need supervision.",
            rat.listing(
                "Partner/Salaried doctors in the session and why each "
                "was ruled out",
                _ineligible_lines(context, grid, gen_week, day, period),
            ),
            rat.decided(
                "no field to compare -- a supervisor must be "
                "Partner/Salaried, free of any role (which excludes "
                "duty doctors, clinics and duty helpers), and not on "
                "leave, WFH, or a no-surgery/admin session"
            ),
        ),
    )


def supervisor_selected(
    context: GenerationContext, counters: CounterState, grid: RotaGrid,
    pool: list[SessionSlot], trainee_count: int,
    gen_week: int, day: Day, period: Period,
) -> tuple[str, str]:
    """`(message, rationale)` for the assignment of `pool[0]`.

    Returned rather than logged because both halves must be built *before*
    the winner's supervision counter is incremented -- see the module
    docstring. The phase increments, then writes the entry with
    `supervisor_assigned`.
    """
    chosen = pool[0]
    message = (
        f"Assigned {context.doctor_by_id[chosen.doctor_id].code} "
        f"as supervisor on {day.value} {period.value} from the "
        f"eligible pool ({_selection_reason(context, counters, pool)}) "
        f"for {trainee_count} trainee(s)."
    )
    rationale = _pool_rationale(
        context, counters, grid, pool, trainee_count, gen_week, day, period,
    )
    return message, rationale


def supervisor_assigned(
    log: DecisionLog, gen_week: int, day: Day, period: Period,
    chosen: SessionSlot, message: str, rationale: str,
) -> None:
    log.add(
        phase=PHASE, action="assign_supervisor",
        week=gen_week, day=day, period=period, doctor_id=chosen.doctor_id,
        room_id=chosen.assigned_room_id,
        message=message, rationale=rationale,
    )


def booked_sr_room(
    log: DecisionLog, context: GenerationContext, gen_week: int, day: Day,
    period: Period, chosen: SessionSlot, previous_room_id: int | None, sr_room,
) -> None:
    """The supervisor being seated in SR -- the one room write Phase 9C makes.

    Names the room they came out of, if any, because that is the only way
    the log shows the template pin this phase deliberately overrode.
    """
    code = context.doctor_by_id[chosen.doctor_id].code
    previous = context.room_by_id[previous_room_id].code if previous_room_id else None
    overrode_pin = (
        previous_room_id is not None and chosen.template_room_id == previous_room_id
    )
    log.add(
        phase=PHASE, action="book_sr_room",
        week=gen_week, day=day, period=period, doctor_id=chosen.doctor_id,
        room_id=sr_room.id, related_room_id=previous_room_id,
        message=(
            f"Seated {code} in SR room {sr_room.code} to supervise on "
            f"{day.value} {period.value} (week {gen_week})"
            + (f", vacating {previous}." if previous else ".")
        ),
        rationale=rat.stages(
            f"{code} was selected as supervisor and "
            + (
                f"was holding {previous}."
                if previous else
                "had no room yet -- Phases 7-9A have not run."
            ),
            f"SR room {sr_room.code} was free: it is held back from every "
            f"other room search in a session with trainees, and the room "
            f"passes run after this phase.",
            rat.decided(
                "supervision is held in the SR room, so the supervisor is "
                "seated there"
                + (
                    "; this overrides the doctor's PRE_ASSIGNED template "
                    "room, the one template pin this phase breaks"
                    if overrode_pin else ""
                )
                + " -- a pure room move that changes no counter, ROOM_MOVE "
                "included"
            ),
        ),
    )


__all__ = [
    "PHASE", "PREFERENCE_MULTIPLIERS", "booked_sr_room",
    "no_eligible_supervisor", "supervision_score", "supervisor_assigned",
    "supervisor_selected",
]
