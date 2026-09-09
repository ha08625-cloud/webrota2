"""Seed doctors and their preferred rooms from setup.csv.

The "All day or half day branch" and "WFH or not" columns are ignored.
sessions_per_week defaults to 10.0 for every doctor (M1 placeholder).
Each preferred-room value resolves to a specific room_id when it matches a room
code (D1-D8, C1-C3, W1-W2, SR), otherwise to a room_type token (D/C/W/SR).
"""
import csv
from decimal import Decimal
from pathlib import Path

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models import Doctor, DoctorPreferredRoom, Room
from app.models.enums import DoctorType, RoomType

DEFAULT_CSV = Path(__file__).parent / "data" / "setup.csv"

_ROOM_TYPE_TOKENS = {rt.value for rt in RoomType}  # {"D","C","W","SR"}

# Preferred Room + Alt Room 1..5 occupy columns 2..7.
_PREF_COLS = range(2, 8)


def _map_doctor_type(raw: str) -> DoctorType:
    t = raw.strip().lower()
    if t == "allied health professionals":
        return DoctorType.AHP
    if t == "partner":
        return DoctorType.PARTNER
    if t == "salaried":
        return DoctorType.SALARIED
    if t == "trainee":
        return DoctorType.TRAINEE
    if t == "locum":
        return DoctorType.LOCUM
    raise ValueError(f"unknown doctor type {raw!r}")


def seed_doctors(session: Session, csv_path: Path | str = DEFAULT_CSV) -> list[Doctor]:
    room_id_by_code = {
        code: rid for code, rid in session.execute(select(Room.code, Room.id)).all()
    }

    doctors: list[Doctor] = []
    with open(csv_path, newline="") as f:
        rows = list(csv.reader(f))

    for row in rows[1:]:  # skip header
        if not row or not row[0].strip():
            continue
        code = row[0].strip()
        doctor = Doctor(
            code=code,
            doctor_type=_map_doctor_type(row[1]),
            sessions_per_week=Decimal("10.0"),
            active=True,
        )

        order = 1
        for col in _PREF_COLS:
            value = row[col].strip() if col < len(row) else ""
            if not value:
                continue
            if value in room_id_by_code:
                doctor.preferred_rooms.append(
                    DoctorPreferredRoom(
                        preference_order=order, room_id=room_id_by_code[value]
                    )
                )
            elif value in _ROOM_TYPE_TOKENS:
                doctor.preferred_rooms.append(
                    DoctorPreferredRoom(
                        preference_order=order, room_type=RoomType(value)
                    )
                )
            else:
                raise ValueError(f"unresolved preferred room {value!r} for {code}")
            order += 1

        doctors.append(doctor)

    session.add_all(doctors)
    session.flush()
    return doctors