"""Shared single-session room relocation search.

Extracted from `phase7_9a.py` Pass 2 (M2 step: room-relocation refactor)
so Phase 4 can reuse the identical search for its evicted Salaried
doctors without duplicating it. Pass 1's full-day relocation is a
separate, deliberately different search (`_pass1_receiving_room` in
phase7_9a.py: fixed C/W/SR pool, no preference list) and stays there --
it has no call site here and none is added.

This module has no knowledge of Phase 4 or duty -- it is the generic
"where does a displaced Salaried/Partner doctor go" search, usable by any
phase that displaces a single-session occupant.
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