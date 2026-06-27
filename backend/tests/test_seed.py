"""Seed-script tests against small hand-built fixture CSVs (not the full data)."""
import csv
from decimal import Decimal

from sqlalchemy import select

from app.models import (
    Doctor,
    DoctorPreferredRoom,
    MasterRotaSession,
    Room,
    SystemCounter,
)
from app.models.enums import DoctorType, MasterSessionType, Period, RoomType, Site
from seed.seed_rooms import seed_rooms
from seed.seed_doctors import seed_doctors
from seed.seed_system_counters import seed_system_counters
from seed.seed_master_rota import seed_master_rota

SETUP_HEADER = [
    "Doctor code", "Type", "Preferred Room", "Alt Room 1", "Alt Room 2",
    "Alt Room 3", "Alt Room 4", "Alt Room 5", "All day or half day branch",
    "WFH or not",
]


def _write_csv(path, rows):
    with open(path, "w", newline="") as f:
        csv.writer(f).writerows(rows)


# --- rooms ---

def test_seed_rooms(session):
    rooms = seed_rooms(session)
    assert len(rooms) == 14
    by_code = {r.code: r for r in rooms}
    assert by_code["D1"].room_type == RoomType.D
    assert by_code["D1"].site == Site.SHC
    assert by_code["C1"].site == Site.CUTTESLOWE
    assert by_code["W1"].site == Site.WOLVERCOTE
    assert by_code["SR"].room_type == RoomType.SR


# --- doctors ---

def test_seed_doctors(session, tmp_path):
    seed_rooms(session)
    csv_path = tmp_path / "setup.csv"
    _write_csv(csv_path, [
        SETUP_HEADER,
        # AA: room code D4 + room-type C; trailing ignored columns populated
        ["AA", "Partner", "D4", "C", "", "", "", "", "", ""],
        # BB: AHP, no preferred rooms, "Half day" branch + WFH flag (both ignored)
        ["BB", "Allied health professionals", "", "", "", "", "", "", "Half day", "Yes"],
        # CC: single specific room
        ["CC", "Trainee", "W1", "", "", "", "", "", "", ""],
    ])
    docs = seed_doctors(session, csv_path)
    by_code = {d.code: d for d in docs}

    assert by_code["BB"].doctor_type == DoctorType.AHP
    assert by_code["AA"].sessions_per_week == Decimal("10.0")

    aa_prefs = by_code["AA"].preferred_rooms
    assert [p.preference_order for p in aa_prefs] == [1, 2]
    assert aa_prefs[0].room_id is not None and aa_prefs[0].room_type is None  # D4
    assert aa_prefs[1].room_id is None and aa_prefs[1].room_type == RoomType.C

    assert by_code["BB"].preferred_rooms == []  # blanks skipped, no rows
    assert len(by_code["CC"].preferred_rooms) == 1


# --- system counters ---

def test_seed_system_counters(session, tmp_path):
    seed_rooms(session)
    csv_path = tmp_path / "setup.csv"
    _write_csv(csv_path, [
        SETUP_HEADER,
        ["AA", "Partner", "D4", "", "", "", "", "", "", ""],
        ["BB", "Salaried", "C1", "", "", "", "", "", "", ""],
    ])
    seed_doctors(session, csv_path)
    counters = seed_system_counters(session)
    assert len(counters) == 4  # 2 doctors x 2 counter types
    per_doctor = {}
    for c in counters:
        per_doctor.setdefault(c.doctor_id, set()).add(c.counter_type.value)
    assert all(types == {"room_move", "supervision"} for types in per_doctor.values())


# --- master rota ---

def _master_rows():
    """Build a 24-col, header + 2-doctor (AM/PM each) master CSV.

    Week blocks: cols 1-5, 7-11, 13-17, 19-23. Separators at 0,6,12,18.
    Every session cell is populated (the parser, like the real file, rejects
    blank session cells); cells default to "No Surgery" and are overridden to
    exercise the other types. Doctor AA covers every session type plus a
    week-specific difference (Thursday week 1 = D1, week 2 = W1). Doctor BB
    checks AM/PM pairing.
    """
    width = 24
    week_base = {1: 1, 2: 7, 3: 13, 4: 19}

    def filled_row():
        # All week/day session cells default to "No Surgery"; col 0 and the
        # separator columns (6, 12, 18) stay blank.
        row = [""] * width
        for base in week_base.values():
            for d in range(5):
                row[base + d] = "No Surgery"
        return row

    header = [""] * width
    header[0] = "WEEK 1"  # parser skips row 0; content irrelevant

    aa_am = filled_row()
    aa_am[0] = "AA"
    aa_am[2] = "ADMIN TIME D7"       # Tue AM week1 (admin + room)
    aa_am[3] = "Working from Home"   # Wed AM week1
    aa_am[4] = "D1"                  # Thu AM week1 -> pre_assigned D1
    aa_am[5] = "D?"                  # Fri AM week1 -> requires_room
    aa_am[10] = "W1"                 # Thu AM week2 -> W1 (week-specific diff)

    aa_pm = filled_row()             # blank col 0 -> PM of AA
    aa_pm[2] = "D2 "                 # Tue PM week1: trailing space -> D2

    bb_am = filled_row()
    bb_am[0] = "BB"
    bb_am[1] = "C1"                  # Mon AM week1

    bb_pm = filled_row()             # blank col 0 -> PM of BB; Mon PM stays No Surgery

    return [header, aa_am, aa_pm, bb_am, bb_pm]


def test_seed_master_rota(session, tmp_path):
    seed_rooms(session)
    # Insert doctors directly so codes match the master fixture.
    session.add_all([
        Doctor(code="AA", doctor_type=DoctorType.PARTNER, sessions_per_week=Decimal("10.0")),
        Doctor(code="BB", doctor_type=DoctorType.SALARIED, sessions_per_week=Decimal("10.0")),
    ])
    session.flush()

    csv_path = tmp_path / "master_rota.csv"
    _write_csv(csv_path, _master_rows())
    template = seed_master_rota(session, csv_path)
    assert template.is_active is True

    room_code = {
        rid: code for code, rid in session.execute(select(Room.code, Room.id)).all()
    }
    aa_id = session.execute(select(Doctor.id).where(Doctor.code == "AA")).scalar_one()

    def cell(week, day, period):
        from app.models.enums import Day
        s = session.execute(
            select(MasterRotaSession).where(
                MasterRotaSession.doctor_id == aa_id,
                MasterRotaSession.week == week,
                MasterRotaSession.day == day,
                MasterRotaSession.period == period,
            )
        ).scalar_one()
        return s.session_type, (room_code.get(s.room_id) if s.room_id else None)

    from app.models.enums import Day
    assert cell(1, Day.MONDAY, Period.AM) == (MasterSessionType.NO_SURGERY, None)
    assert cell(1, Day.TUESDAY, Period.AM) == (MasterSessionType.ADMIN_TIME, "D7")
    assert cell(1, Day.WEDNESDAY, Period.AM) == (MasterSessionType.WFH, None)
    assert cell(1, Day.FRIDAY, Period.AM) == (MasterSessionType.REQUIRES_ROOM, None)
    # trailing space handled (uppercase room code)
    assert cell(1, Day.TUESDAY, Period.PM) == (MasterSessionType.PRE_ASSIGNED, "D2")
    # week-specific difference: Thursday D1 (wk1) vs W1 (wk2)
    assert cell(1, Day.THURSDAY, Period.AM) == (MasterSessionType.PRE_ASSIGNED, "D1")
    assert cell(2, Day.THURSDAY, Period.AM) == (MasterSessionType.PRE_ASSIGNED, "W1")

    # AM/PM pairing for BB (blank code row belongs to BB)
    bb_id = session.execute(select(Doctor.id).where(Doctor.code == "BB")).scalar_one()
    bb_mon_pm = session.execute(
        select(MasterRotaSession).where(
            MasterRotaSession.doctor_id == bb_id,
            MasterRotaSession.week == 1,
            MasterRotaSession.day == Day.MONDAY,
            MasterRotaSession.period == Period.PM,
        )
    ).scalar_one()
    assert bb_mon_pm.session_type == MasterSessionType.NO_SURGERY

    # full row count: 2 doctors x 4 weeks x 5 days x 2 periods
    total = session.execute(select(MasterRotaSession)).all()
    assert len(total) == 2 * 4 * 5 * 2