"""Seed the master rota template and its sessions from master_rota.csv.

Format (confirmed against the real file):
- Row 0 is a header and is skipped.
- Each doctor occupies two consecutive rows: the AM row carries the code in
  column 0; the PM row has a blank column 0 and belongs to the doctor above.
- Four week-blocks at fixed offsets: week 1 = cols 1-5, week 2 = 7-11,
  week 3 = 13-17, week 4 = 19-23 (Mon-Fri). Columns 0, 6, 12, 18 are
  label/separator columns, skipped by position.
- Cell values are whitespace-collapsed and matched case-insensitively.
"""
import csv
from pathlib import Path

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models import Doctor, MasterRotaSession, MasterRotaTemplate, Room
from app.models.enums import Day, MasterSessionType, Period

DEFAULT_CSV = Path(__file__).parent / "data" / "master_rota.csv"

_WEEK_BASE = {1: 1, 2: 7, 3: 13, 4: 19}  # column of Monday for each week
_DAYS = [Day.MONDAY, Day.TUESDAY, Day.WEDNESDAY, Day.THURSDAY, Day.FRIDAY]
_ROOM_CODES = {f"D{i}" for i in range(1, 9)} | {"C1", "C2", "C3", "W1", "W2", "SR"}


def _map_cell(raw: str) -> tuple[MasterSessionType, str | None]:
    """Return (session_type, room_code_or_None) for one cell."""
    value = " ".join(raw.split())  # collapse all whitespace
    low = value.lower()
    if low == "no surgery":
        return MasterSessionType.NO_SURGERY, None
    if low == "admin time":
        return MasterSessionType.ADMIN_TIME, None
    if low.startswith("admin time "):
        room = value[len("admin time "):].strip()
        if room not in _ROOM_CODES:
            raise ValueError(f"admin time references unknown room {room!r}")
        return MasterSessionType.ADMIN_TIME, room
    if low == "working from home":
        return MasterSessionType.WFH, None
    if value == "D?":
        return MasterSessionType.REQUIRES_ROOM, None
    if value in _ROOM_CODES:
        return MasterSessionType.PRE_ASSIGNED, value
    raise ValueError(f"unrecognised master rota cell {raw!r}")


def seed_master_rota(
    session: Session, csv_path: Path | str = DEFAULT_CSV
) -> MasterRotaTemplate:
    doctor_id_by_code = {
        code: did for code, did in session.execute(select(Doctor.code, Doctor.id)).all()
    }
    room_id_by_code = {
        code: rid for code, rid in session.execute(select(Room.code, Room.id)).all()
    }

    template = MasterRotaTemplate(name="Default", is_active=True)
    session.add(template)
    session.flush()

    with open(csv_path, newline="") as f:
        rows = list(csv.reader(f))
    rows = rows[1:]  # skip header

    sessions: list[MasterRotaSession] = []
    i = 0
    while i < len(rows):
        am_row = rows[i]
        pm_row = rows[i + 1]
        code = am_row[0].strip()
        if not code:
            raise ValueError(f"expected a doctor code at data row {i}")
        if pm_row[0].strip():
            raise ValueError(
                f"expected blank PM code at data row {i + 1}, got {pm_row[0]!r}"
            )
        if code not in doctor_id_by_code:
            raise ValueError(f"master rota doctor {code!r} not found in doctors table")
        did = doctor_id_by_code[code]

        for week, base in _WEEK_BASE.items():
            for day_idx, day in enumerate(_DAYS):
                col = base + day_idx
                for period, prow in ((Period.AM, am_row), (Period.PM, pm_row)):
                    stype, room_code = _map_cell(prow[col])
                    sessions.append(
                        MasterRotaSession(
                            template_id=template.id,
                            doctor_id=did,
                            week=week,
                            day=day,
                            period=period,
                            session_type=stype,
                            room_id=room_id_by_code[room_code] if room_code else None,
                        )
                    )
        i += 2

    session.add_all(sessions)
    session.flush()
    return template