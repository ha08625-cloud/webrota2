"""Seed the 18 physical rooms. Hardcoded (not from CSV).

Idempotent on `code`: migration 019 inserts the four treatment rooms into
databases that already exist, so a fresh database that runs
`alembic upgrade head` and then `seed.run_all` would otherwise collide on
`uq_rooms_code`. Inserting only the missing codes keeps this script safe to
re-run generally.
"""
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models import Room
from app.models.enums import RoomType, Site

# (code, room_type, site)
ROOMS = [
    ("D1", RoomType.D, Site.SHC),
    ("D2", RoomType.D, Site.SHC),
    ("D3", RoomType.D, Site.SHC),
    ("D4", RoomType.D, Site.SHC),
    ("D5", RoomType.D, Site.SHC),
    ("D6", RoomType.D, Site.SHC),
    ("D7", RoomType.D, Site.SHC),
    ("D8", RoomType.D, Site.SHC),
    ("C1", RoomType.C, Site.CUTTESLOWE),
    ("C2", RoomType.C, Site.CUTTESLOWE),
    ("C3", RoomType.C, Site.CUTTESLOWE),
    ("W1", RoomType.W, Site.WOLVERCOTE),
    ("W2", RoomType.W, Site.WOLVERCOTE),
    ("SR", RoomType.SR, Site.SHC),
    ("TR1", RoomType.TR, Site.SHC),
    ("TR2", RoomType.TR, Site.SHC),
    ("TR3", RoomType.TR, Site.SHC),
    ("CK", RoomType.TR, Site.CUTTESLOWE),
]


def seed_rooms(session: Session) -> list[Room]:
    """Insert any rooms that are missing and return all 18, in `ROOMS` order."""
    existing = {
        r.code: r for r in session.execute(select(Room)).scalars()
    }
    created = [
        Room(code=c, room_type=rt, site=s)
        for c, rt, s in ROOMS
        if c not in existing
    ]
    session.add_all(created)
    session.flush()
    by_code = existing | {r.code: r for r in created}
    return [by_code[c] for c, _, _ in ROOMS]
