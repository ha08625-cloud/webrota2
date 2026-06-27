"""Seed the 14 physical rooms. Hardcoded (not from CSV)."""
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
]


def seed_rooms(session: Session) -> list[Room]:
    rooms = [Room(code=c, room_type=rt, site=s) for c, rt, s in ROOMS]
    session.add_all(rooms)
    session.flush()
    return rooms