"""Seed system counters: one room_move + one supervision row per doctor.

Invariant (matches the doctors router): every doctor has exactly one
SystemCounter row per SystemCounterType, regardless of doctor_type or
active flag. Trainee/AHP rows are never incremented (only Partner/Salaried
are displaceable or supervision-eligible) and sit unused at zero -- the
cost of a handful of dead rows buys a single unconditional invariant that
survives a later PATCH changing a doctor's type. `generate._write_counters`
enforces the invariant with a strict `.scalar_one()`.

Fresh-database seed only: not idempotent (uq_system_counter will reject a
re-run against existing rows). For repairing an existing database, use
seed/backfill_system_counters.py instead.
"""
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models import Doctor, SystemCounter
from app.models.enums import SystemCounterType


def seed_system_counters(session: Session) -> list[SystemCounter]:
    doctor_ids = session.execute(select(Doctor.id)).scalars().all()

    counters: list[SystemCounter] = []
    for did in doctor_ids:
        for ct in (SystemCounterType.ROOM_MOVE, SystemCounterType.SUPERVISION):
            counters.append(SystemCounter(doctor_id=did, counter_type=ct, raw_count=0))

    session.add_all(counters)
    session.flush()
    return counters
