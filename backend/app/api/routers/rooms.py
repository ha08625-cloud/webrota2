"""Rooms router (M3 Task 6). Read-only in M3; rooms come from seed_rooms."""
from __future__ import annotations

from fastapi import APIRouter, Depends
from sqlalchemy import select
from sqlalchemy.orm import Session

from ...models import Room
from ..deps import get_current_user, get_db
from ..schemas import RoomOut

router = APIRouter(prefix="/rooms", tags=["rooms"])


@router.get("", response_model=list[RoomOut])
def list_rooms(
    db: Session = Depends(get_db),
    user: dict = Depends(get_current_user),
) -> list[Room]:
    return db.execute(select(Room).order_by(Room.code)).scalars().all()
