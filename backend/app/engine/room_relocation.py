"""Shared single-session room relocation searches.

`find_relocation_room` was extracted from `phase7_9a.py` Pass 2 (M2 step:
room-relocation refactor) so Phase 4 can reuse the identical search for
its evicted Salaried doctors without duplicating it. Pass 1's full-day
relocation is a separate, deliberately different search
(`_pass1_receiving_room` in phase7_9a.py: fixed C/W/SR pool, no
preference list) and stays there -- it has no call site here and none is
added.

`find_d_room_only` was added for Phase 4 (Design Decision 8): when a duty
doctor evicts a Trainee from a D room, the Trainee is relocated within D
rooms only, never into C/W/SR. Renamed from `find_trainee_d_room` when
Locum was added (Locum ticket, Design Decision 1: Locum behaves as
Trainee-minus-supervision and shares this same relocation path).

This module has no knowledge of Phase 4 or duty -- it is the generic
"where does a displaced doctor go" search, usable by any phase that
displaces a single-session occupant.
"""
from __future__ import annotations

from ..models.enums import Day, Period, RoomType
from .datatypes import GenerationContext, RotaGrid

_ROOM_MOVE_FALLBACK_TYPES = (RoomType.C, RoomType.W, RoomType.SR)


def find_relocation_room(
    context: GenerationContext, grid: RotaGrid, doctor_id: int,
    gen_week: int, day: Day, period: Period,
) -> int | None:
    """The room-preference-assignment algorithm for a displaced doctor.

    Tries the doctor's own preferred rooms first (skipping D rooms --
    they were just displaced *out* of a D room), then falls back to any
    free room of an eligible non-D type (C, W, SR). The room must be free
    in `period` on `gen_week`/`day`.

    Returns `None` if nothing on the preference list nor the C/W/SR pool
    is free.
    """
    for room_id in context.preferred_rooms_by_doctor.get(doctor_id, ()):
        if context.room_by_id[room_id].room_type == RoomType.D:
            continue
        if grid.is_room_free(gen_week, day, period, room_id):
            return room_id

    fallback_ids = sorted(
        r.id for r in context.rooms if r.room_type in _ROOM_MOVE_FALLBACK_TYPES
    )
    for room_id in fallback_ids:
        if grid.is_room_free(gen_week, day, period, room_id):
            return room_id

    return None


def find_d_room_only(
    context: GenerationContext, grid: RotaGrid, doctor_id: int,
    gen_week: int, day: Day, period: Period,
) -> int | None:
    """Single-session, D-room-only relocation search for a displaced
    Trainee or Locum (Phase 4, Design Decision 8).

    Tries the doctor's own preferred D-type rooms in preference order
    first, then any other free D room by code ascending -- the engine's
    usual ascending convention, deliberately not the code-descending
    order Phase 4's own fallback sweep uses when placing the duty doctor
    (see phase4.py Design Decision 8/12a: those two orderings solve
    different problems and are not meant to be harmonised).

    Used for both Trainee and Locum evictees -- Locum behaves as
    Trainee-minus-supervision (Locum ticket, Design Decision 1).

    Returns `None` if no D room is free. Never falls back to C/W/SR.
    """
    for room_id in context.preferred_rooms_by_doctor.get(doctor_id, ()):
        if context.room_by_id[room_id].room_type != RoomType.D:
            continue
        if grid.is_room_free(gen_week, day, period, room_id):
            return room_id

    fallback_ids = sorted(
        (r.id for r in context.rooms_by_type.get(RoomType.D, ())),
        key=lambda rid: context.room_by_id[rid].code,
    )
    for room_id in fallback_ids:
        if grid.is_room_free(gen_week, day, period, room_id):
            return room_id

    return None