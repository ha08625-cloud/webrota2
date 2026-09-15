"""Helpers shared by more than one phase.

Three kinds of thing live here:

  - The little description helpers (`code`, `room_state`) that the phases'
    decision-log prose is assembled from. Every phase names doctors and
    rooms the same way, and an `id=7` fallback rather than a KeyError when
    a doctor has gone missing from the context.
  - `room_move_rank` and `room_move_score_text` -- the room-move ranking
    that Phases 4 and 7-9A sort their eviction candidates by, and the
    sentence that explains it. They sit together deliberately: the
    narration must read the same key the sort read, or the log will
    confidently describe a decision the engine did not make.
  - `INERT_TYPES` / `is_inert` -- the cross-phase "the engine neither
    allocates for nor moves this person" rule, consulted by Phases 4 and 5.
  - `NON_ALLOCATABLE_ROOM_TYPES` -- the room-side mirror of that rule:
    room types no phase may ever hand out. Nothing reads it; it exists so
    the rule has a name and one place to be documented.

Nothing here writes to the grid or the counters.
"""
from __future__ import annotations

from ...models.enums import Day, DoctorType, Period, RoomType, SystemCounterType
from .. import rationale as rat
from ..datatypes import CounterState, GenerationContext, RotaGrid


# Staff types the generation engine never allocates for and never moves.
INERT_TYPES = (DoctorType.NURSE,)


# Room types no generation phase may ever allocate. TR covers the treatment
# rooms (TR1-TR3 at SHC) and the Cutteslowe kitchen (CK): rooms a human
# fills from the master rota or by manual edit, and that the engine must
# leave alone.
#
# Nothing in the engine reads this constant, and that is the point. The
# guarantee is not a check anywhere -- it is *absence* from the four
# room-type collections every phase reaches rooms through:
#
#   - `phase7_9a._ROOM_MOVE_FALLBACK_TYPES`  (Pass 1's receiving-room pool)
#   - `phase7_9a._PASS3_FALLBACK_TYPE_ORDER` (Pass 3's forced-room order)
#   - `room_relocation._ROOM_MOVE_FALLBACK_TYPES` (displaced-occupant pool)
#   - `phase9c._SUPERVISOR_ROOM_TYPES`       (where a supervisor may sit)
#
# Every other room lookup in the engine names a single type explicitly
# (`rooms_by_type.get(RoomType.D, ())`), so it cannot acquire TR by
# accident. Absence is not something code can state, exactly as with
# `INERT_TYPES`: adding a type here alone would give it no guarantee at all
# while looking like it had. `tests/test_engine/test_non_allocatable_rooms.py`
# is what pins the two halves together -- it asserts disjointness from each
# of the four tuples above, and runs a full generation under real room
# pressure to cover the preference walks and inline single-type lookups no
# tuple assertion can reach.
#
# The one path that can still put a doctor in a TR room is a stored
# `Doctor.preferred_rooms` entry naming one: three phases walk a doctor's
# own preference list with no room-type allowlist. That hole is closed at
# the API rather than in the engine -- the same treatment SR gets -- so
# `load_context()` keeps expanding whatever is stored and the engine stays
# honest about the data.
NON_ALLOCATABLE_ROOM_TYPES = (RoomType.TR,)


def is_inert(context: GenerationContext, doctor_id: int) -> bool:
    """True for a staff member the engine treats as inert.

    Inert means three things:

      1. No demand. An inert doctor never causes the engine to allocate
         anything -- no D-room demand in Phases 7-9A, no clinic candidacy
         in Phase 5.
      2. Immovable. No phase moves an inert doctor out of the room Phase 2
         gave them, ever -- including when the alternative is another
         doctor going roomless. There is no last-resort exception.
      3. Opaque. Their room is a normal occupied room to everybody else.
         This needs no code: inert doctors stay in `context.doctors` and in
         the grid, so `grid.assign_room` in Phase 2 already makes
         `is_room_free` false for their room and every free-room search in
         every phase routes around it. Filtering them out of the engine
         would release those rooms, which is the opposite of what is
         wanted.

    This predicate expresses half of that rule. The other half -- no
    demand, and no eviction by Phase 4's fallback sweep or Phase 7-9A's
    victim search -- is enforced by an inert type being *absent from*
    `phase7_9a._D_ROOM_TYPES`, `phase7_9a._DISPLACEABLE_TYPES`,
    `phase9b._SWAPPABLE_TYPES` and `phase9c._SUPERVISOR_TYPES`. Absence is
    not something a predicate can state, so adding a type to `INERT_TYPES`
    alone would give it neither guarantee while looking like it had.
    `tests/test_engine/test_inert.py` is what pins the two halves together:
    it asserts `INERT_TYPES` is disjoint from each of those four tuples.
    """
    doctor = context.doctor_by_id.get(doctor_id)
    return doctor is not None and doctor.doctor_type in INERT_TYPES


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
