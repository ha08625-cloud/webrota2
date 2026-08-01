"""Seed the reception coverage rules. Hardcoded (not from CSV), mirroring
seed_rooms.py's shape: one row per (day, hour), 3 required phones staff for
the half-hour slots inside the 9am and 10am hours, 2 for every other slot,
applied identically across all five weekdays."""
from sqlalchemy.orm import Session

from app.models import ReceptionCoverageRule
from app.models.enums import Day
from app.models.reception import RECEPTION_HOURS

_BUSY_HOURS = {9.0, 9.5, 10.0, 10.5}


def seed_reception_coverage(session: Session) -> list[ReceptionCoverageRule]:
    rules = [
        ReceptionCoverageRule(
            day=day,
            hour=hour,
            min_phones_staff=3 if hour in _BUSY_HOURS else 2,
        )
        for day in Day
        for hour in RECEPTION_HOURS
    ]
    session.add_all(rules)
    session.flush()
    return rules
