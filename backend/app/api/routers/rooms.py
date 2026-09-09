"""Rooms router. Read-only: rooms are created by seed/seed_rooms.py."""
from __future__ import annotations

from fastapi import APIRouter, Depends
from sqlalchemy import select
from sqlalchemy.orm import Session

from ...models import Room, User
from ..deps import get_current_user, get_db
from ..schemas import RoomOut

router = APIRouter(prefix="/rooms", tags=["rooms"])


@router.get("", response_model=list[RoomOut])
def list_rooms(
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
) -> list[Room]:
    return db.execute(select(Room).order_by(Room.code)).scalars().all()
