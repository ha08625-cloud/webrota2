"""Helpers shared by more than one phase.

Two kinds of thing live here, and they are related:

  - The little description helpers (`code`, `room_state`) that the phases'
    decision-log prose is assembled from. Every phase names doctors and
    rooms the same way, and an `id=7` fallback rather than a KeyError when
    a doctor has gone missing from the context.
  - `room_move_rank` and `room_move_score_text` -- the room-move ranking
    that Phases 4 and 7-9A sort their eviction candidates by, and the
    sentence that explains it. They sit together deliberately: the
    narration must read the same key the sort read, or the log will
    confidently describe a decision the engine did not make.

Nothing here writes to the grid or the counters.
"""
from __future__ import annotations

from ...models.enums import Day, Period, SystemCounterType
from .. import rationale as rat
from ..datatypes import CounterState, GenerationContext, RotaGrid


def code(context: GenerationContext, doctor_id: int) -> str:
    """A doctor's code, or `id=N` if they are not in the context."""
    doctor = context.doctor_by_id.get(doctor_id)
    return doctor.code if doctor is not None else f"id={doctor_id}"


def room_state(
    context: GenerationContext, grid: RotaGrid,
    gen_week: int, day: Day, period: Period, room_id: int,
) -> str:
    """`"R1: free"` / `"R1: held by AB"` for one room in one session."""
    occupant_id = grid.get_room_occupant(gen_week, day, period, room_id)
    room_code = context.room_by_id[room_id].code
    if occupant_id is None:
        return f"{room_code}: free"
    return f"{room_code}: held by {code(context, occupant_id)}"


def is_room_free_all_day(grid: RotaGrid, gen_week: int, day: Day, room_id: int) -> bool:
    """Free in both AM and PM -- the "can this doctor keep one room all day"
    test Phases 4 and 7-9A both make."""
    return (
        grid.is_room_free(gen_week, day, Period.AM, room_id)
        and grid.is_room_free(gen_week, day, Period.PM, room_id)
    )


def room_move_rank(
    context: GenerationContext, counters: CounterState, doctor_id: int
) -> tuple[float, str]:
    """`(weighted room-move score, doctor code)` -- the sort key for
    "who is least disrupted by being moved again"."""
    spw = context.spw_by_id.get(doctor_id, 0.0)
    score = counters.weighted_system_score(doctor_id, SystemCounterType.ROOM_MOVE, spw)
    return (score, context.doctor_by_id[doctor_id].code)


def room_move_score_text(
    context: GenerationContext, counters: CounterState, doctor_id: int
) -> str:
    """The `rat.score` line behind `room_move_rank`'s first element."""
    spw = context.spw_by_id.get(doctor_id, 0.0)
    raw = counters.system.get((doctor_id, SystemCounterType.ROOM_MOVE), 0)
    return rat.score(
        raw,
        spw,
        counters.weighted_system_score(doctor_id, SystemCounterType.ROOM_MOVE, spw),
        counters.system_opening_balance(doctor_id, SystemCounterType.ROOM_MOVE),
    )
