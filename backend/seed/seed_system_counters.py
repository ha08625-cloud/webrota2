"""Seed system counters: one room_move + one supervision row per active
Partner/Salaried doctor."""
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models import Doctor, SystemCounter
from app.models.enums import DoctorType, SystemCounterType

_COUNTED_TYPES = (DoctorType.PARTNER, DoctorType.SALARIED)


def seed_system_counters(session: Session) -> list[SystemCounter]:
    """Seed system counters for Partners and Salaried doctors only.

    Trainees and AHPs are never the doctor_id incremented for ROOM_MOVE
    (only Partner/Salaried are displaceable, see phase7_9a._DISPLACEABLE_TYPES)
    or SUPERVISION (only Partner/Salaried are eligible supervisors, see
    phase9c._SUPERVISOR_TYPES), so they never need a row.
    """
    doctor_ids = session.execute(
        select(Doctor.id).where(
            Doctor.active.is_(True),
            Doctor.doctor_type.in_(_COUNTED_TYPES),
        )
    ).scalars().all()

    counters: list[SystemCounter] = []
    for did in doctor_ids:
        for ct in (SystemCounterType.ROOM_MOVE, SystemCounterType.SUPERVISION):
            counters.append(SystemCounter(doctor_id=did, counter_type=ct, raw_count=0))

    session.add_all(counters)
    session.flush()
    return counters