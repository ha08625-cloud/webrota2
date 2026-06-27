"""Seed system counters: one room_move + one supervision row per active doctor."""
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models import Doctor, SystemCounter
from app.models.enums import SystemCounterType


def seed_system_counters(session: Session) -> list[SystemCounter]:
    doctor_ids = session.execute(
        select(Doctor.id).where(Doctor.active.is_(True))
    ).scalars().all()

    counters: list[SystemCounter] = []
    for did in doctor_ids:
        for ct in (SystemCounterType.ROOM_MOVE, SystemCounterType.SUPERVISION):
            counters.append(SystemCounter(doctor_id=did, counter_type=ct, raw_count=0))

    session.add_all(counters)
    session.flush()
    return counters