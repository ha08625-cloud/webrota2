"""Tests for `app/calendar_feed.py`.

No `TestClient` anywhere: the builder is a pure database-to-bytes function
and the route that will call it is Task 3's problem. Output is parsed back
with `icalendar` rather than string-matched, which is the whole reason the
library is a dependency -- a hand-rolled assertion on the raw bytes would
not catch the escaping and folding bugs the library exists to prevent.
"""
import datetime

import pytest
from icalendar import Calendar

from app import calendar_feed
from app.calendar_feed import UID_DOMAIN, build_feed
from app.models.clinic_type import ClinicType
from app.models.closure import PracticeClosure, RotaClosure
from app.models.doctor import Doctor
from app.models.enums import (
    Day,
    DoctorType,
    MasterSessionType,
    Period,
    RotaStatus,
    SessionRole,
    Site,
    RoomType,
)
from app.models.leave import LeaveEntry
from app.models.room import Room
from app.models.rota import GeneratedRota, RotaConfig, RotaSession

# A Monday, comfortably inside the default 56-day history window relative to
# TODAY below.
START = datetime.date(2026, 6, 1)
TODAY = datetime.date(2026, 6, 3)


@pytest.fixture
def doctor(session) -> Doctor:
    doc = Doctor(code="ABC", doctor_type=DoctorType.PARTNER)
    session.add(doc)
    session.commit()
    return doc


def make_rota(
    session,
    *,
    start_date: datetime.date = START,
    num_weeks: int = 1,
    status: RotaStatus = RotaStatus.COMMITTED,
    archived: bool = False,
) -> GeneratedRota:
    config = RotaConfig(start_date=start_date, num_weeks=num_weeks)
    session.add(config)
    session.flush()
    rota = GeneratedRota(
        config_id=config.id,
        status=status,
        archived_at=(
            datetime.datetime(2026, 6, 2, tzinfo=datetime.timezone.utc)
            if archived
            else None
        ),
    )
    session.add(rota)
    session.commit()
    return rota


def add_session(
    session,
    rota: GeneratedRota,
    doctor: Doctor,
    *,
    day: Day = Day.MONDAY,
    period: Period = Period.AM,
    week: int = 1,
    template_type: MasterSessionType | None = MasterSessionType.REQUIRES_ROOM,
    **kwargs,
) -> RotaSession:
    row = RotaSession(
        rota_id=rota.id,
        doctor_id=doctor.id,
        week=week,
        day=day,
        period=period,
        template_type=template_type,
        **kwargs,
    )
    session.add(row)
    session.commit()
    return row


def events(session, doctor, today: datetime.date = TODAY):
    parsed = Calendar.from_ical(build_feed(session, doctor, today))
    return list(parsed.walk("VEVENT"))


def summaries(session, doctor, today: datetime.date = TODAY) -> list[str]:
    return [str(event["SUMMARY"]) for event in events(session, doctor, today)]


# --- which rotas and sessions are included -------------------------------


def test_committed_rota_produces_one_event_per_session(session, doctor):
    rota = make_rota(session)
    add_session(session, rota, doctor, day=Day.MONDAY, period=Period.AM)
    add_session(session, rota, doctor, day=Day.TUESDAY, period=Period.PM)

    assert len(events(session, doctor)) == 2


def test_draft_rota_produces_nothing(session, doctor):
    rota = make_rota(session, status=RotaStatus.DRAFT)
    add_session(session, rota, doctor)

    assert events(session, doctor) == []


def test_archived_rota_is_included(session, doctor):
    rota = make_rota(session, archived=True)
    add_session(session, rota, doctor)

    assert len(events(session, doctor)) == 1


def test_another_doctors_sessions_are_not_included(session, doctor):
    other = Doctor(code="XYZ", doctor_type=DoctorType.SALARIED)
    session.add(other)
    session.commit()
    rota = make_rota(session)
    add_session(session, rota, other)

    assert events(session, doctor) == []


def test_no_surgery_session_produces_nothing(session, doctor):
    rota = make_rota(session)
    add_session(session, rota, doctor, template_type=MasterSessionType.NO_SURGERY)

    assert events(session, doctor) == []


@pytest.mark.parametrize(
    "template_type",
    [
        MasterSessionType.REQUIRES_ROOM,
        MasterSessionType.PRE_ASSIGNED,
        MasterSessionType.ADMIN_TIME,
        MasterSessionType.WFH,
        None,  # legacy pre-M3.6 row: reads as a normal session
    ],
)
def test_working_session_types_are_included(session, doctor, template_type):
    rota = make_rota(session)
    add_session(session, rota, doctor, template_type=template_type)

    assert len(events(session, doctor)) == 1


def test_session_before_the_history_window_is_absent(session, doctor):
    rota = make_rota(session)
    add_session(session, rota, doctor)

    # A "today" far enough forward that the whole rota range is behind the
    # cutoff: the rota is not queried at all.
    assert events(session, doctor, TODAY + datetime.timedelta(days=365)) == []


def test_window_cutoff_falls_inside_a_rota(session, doctor):
    """A rota straddling the cutoff keeps only its post-cutoff sessions."""
    rota = make_rota(session, num_weeks=4)
    add_session(session, rota, doctor, week=1, day=Day.MONDAY)
    add_session(session, rota, doctor, week=4, day=Day.MONDAY)

    # 56 days after week 1's Monday, so week 1 is out and week 4 is in.
    today = START + datetime.timedelta(days=calendar_feed.HISTORY_DAYS + 1)
    parsed_events = events(session, doctor, today)
    assert len(parsed_events) == 1
    assert parsed_events[0]["DTSTART"].dt.date() == START + datetime.timedelta(days=21)


# --- closures ------------------------------------------------------------


def test_closed_slot_produces_nothing(session, doctor):
    rota = make_rota(session)
    add_session(session, rota, doctor, period=Period.AM)
    session.add(RotaClosure(rota_id=rota.id, date=START, period=Period.AM))
    session.commit()

    assert events(session, doctor) == []


def test_closure_is_read_from_the_rota_snapshot_not_the_live_table(session, doctor):
    """A `PracticeClosure` added after the rota must not change its feed."""
    rota = make_rota(session)
    add_session(session, rota, doctor, period=Period.AM)
    session.add(PracticeClosure(date=START, period=Period.AM, name="Added later"))
    session.commit()

    assert len(events(session, doctor)) == 1


def test_another_rotas_closure_does_not_apply(session, doctor):
    rota = make_rota(session)
    other = make_rota(session, start_date=START + datetime.timedelta(days=7))
    add_session(session, rota, doctor, period=Period.AM)
    session.add(RotaClosure(rota_id=other.id, date=START, period=Period.AM))
    session.commit()

    assert len(events(session, doctor)) == 1


# --- leave ---------------------------------------------------------------


def test_full_day_leave_produces_one_all_day_event(session, doctor):
    rota = make_rota(session)
    add_session(session, rota, doctor, period=Period.AM)
    add_session(session, rota, doctor, period=Period.PM)
    session.add_all(
        [
            LeaveEntry(doctor_id=doctor.id, date=START, period=Period.AM),
            LeaveEntry(doctor_id=doctor.id, date=START, period=Period.PM),
        ]
    )
    session.commit()

    parsed_events = events(session, doctor)
    assert len(parsed_events) == 1
    event = parsed_events[0]
    assert str(event["SUMMARY"]) == "Annual leave"
    assert event["DTSTART"].dt == START
    assert event["DTEND"].dt == START + datetime.timedelta(days=1)
    assert str(event["UID"]) == f"leave-{doctor.id}-20260601@{UID_DOMAIN}"


def test_half_day_leave_produces_a_timed_leave_event_and_a_session_event(
    session, doctor
):
    rota = make_rota(session)
    am = add_session(session, rota, doctor, period=Period.AM)
    add_session(session, rota, doctor, period=Period.PM)
    session.add(LeaveEntry(doctor_id=doctor.id, date=START, period=Period.AM))
    session.commit()

    parsed_events = {str(e["SUMMARY"]): e for e in events(session, doctor)}
    assert set(parsed_events) == {"Annual leave (AM)", "Session"}
    leave = parsed_events["Annual leave (AM)"]
    assert str(leave["UID"]) == f"leave-{am.id}@{UID_DOMAIN}"
    # Timed, not all-day, and using the AM period's own times.
    assert isinstance(leave["DTSTART"].dt, datetime.datetime)
    assert leave["DTSTART"].dt == calendar_feed._utc(START, calendar_feed.AM_START)


def test_leave_on_a_no_surgery_slot_produces_nothing(session, doctor):
    """Filter order is closure -> session type -> leave."""
    rota = make_rota(session)
    add_session(
        session,
        rota,
        doctor,
        period=Period.AM,
        template_type=MasterSessionType.NO_SURGERY,
    )
    session.add(LeaveEntry(doctor_id=doctor.id, date=START, period=Period.AM))
    session.commit()

    assert events(session, doctor) == []


def test_leave_on_a_closed_slot_produces_nothing(session, doctor):
    rota = make_rota(session)
    add_session(session, rota, doctor, period=Period.AM)
    session.add_all(
        [
            RotaClosure(rota_id=rota.id, date=START, period=Period.AM),
            LeaveEntry(doctor_id=doctor.id, date=START, period=Period.AM),
        ]
    )
    session.commit()

    assert events(session, doctor) == []


def test_leave_on_an_unrostered_date_is_silent(session, doctor):
    """Leave only ever appears where a session was actually suppressed."""
    rota = make_rota(session)
    add_session(session, rota, doctor, day=Day.MONDAY, period=Period.AM)
    # Tuesday: the doctor has no session row at all (a part-timer's day off).
    session.add(
        LeaveEntry(
            doctor_id=doctor.id,
            date=START + datetime.timedelta(days=1),
            period=Period.AM,
        )
    )
    session.commit()

    assert summaries(session, doctor) == ["Session"]


# --- event content -------------------------------------------------------


def test_summary_and_location_carry_the_room_and_clinic_type(session, doctor):
    room = Room(code="C3", room_type=RoomType.C, site=Site.SHC)
    clinic = ClinicType(name="Diabetes", clinic_priority=1)
    session.add_all([room, clinic])
    session.flush()
    rota = make_rota(session)
    add_session(
        session,
        rota,
        doctor,
        room_id=room.id,
        clinic_type_id=clinic.id,
        role=SessionRole.CLINIC,
    )

    event = events(session, doctor)[0]
    assert str(event["SUMMARY"]) == "C3 — Diabetes"
    assert str(event["LOCATION"]) == "C3"


@pytest.mark.parametrize(
    ("role", "expected"),
    [
        (SessionRole.DUTY_PRIMARY, "R1 — Duty"),
        (SessionRole.DUTY_SECONDARY, "R1 — Duty (2nd)"),
        (None, "R1 — Session"),
    ],
)
def test_duty_roles_render_in_the_clinic_type_position(session, doctor, role, expected):
    room = Room(code="R1", room_type=RoomType.D, site=Site.SHC)
    session.add(room)
    session.flush()
    rota = make_rota(session)
    add_session(session, rota, doctor, room_id=room.id, role=role)

    assert summaries(session, doctor) == [expected]


def test_admin_time_says_admin_and_has_no_room(session, doctor):
    rota = make_rota(session)
    add_session(session, rota, doctor, template_type=MasterSessionType.ADMIN_TIME)

    event = events(session, doctor)[0]
    assert str(event["SUMMARY"]) == "Admin"
    assert "LOCATION" not in event


def test_wfh_is_prefixed_and_carries_no_room(session, doctor):
    room = Room(code="C3", room_type=RoomType.C, site=Site.SHC)
    session.add(room)
    session.flush()
    rota = make_rota(session)
    add_session(
        session,
        rota,
        doctor,
        room_id=room.id,
        is_wfh=True,
        template_type=MasterSessionType.WFH,
    )

    event = events(session, doctor)[0]
    assert str(event["SUMMARY"]) == "WFH: Session"
    assert "LOCATION" not in event


def test_description_carries_doctor_code_supervising_and_notes(session, doctor):
    rota = make_rota(session)
    add_session(session, rota, doctor, is_supervising=True, notes="phone only")

    description = str(events(session, doctor)[0]["DESCRIPTION"])
    assert description.split("\n") == ["ABC", "Supervising", "phone only"]


def test_special_characters_round_trip(session, doctor):
    """Commas, semicolons and backslashes must survive serialisation.

    Getting this wrong produces a file Google silently refuses to parse, and
    it is the reason the ICS text is not hand-rolled.
    """
    room = Room(code="A,1;B\\2", room_type=RoomType.C, site=Site.SHC)
    session.add(room)
    session.flush()
    rota = make_rota(session)
    add_session(session, rota, doctor, room_id=room.id, notes="one, two; three\\four")

    event = events(session, doctor)[0]
    assert str(event["LOCATION"]) == "A,1;B\\2"
    assert str(event["SUMMARY"]) == "A,1;B\\2 — Session"
    assert str(event["DESCRIPTION"]).endswith("one, two; three\\four")


# --- UIDs ----------------------------------------------------------------


def test_uid_is_the_session_id_and_survives_an_edit(session, doctor):
    rota = make_rota(session)
    row = add_session(session, rota, doctor)
    expected = f"{row.id}@{UID_DOMAIN}"
    assert str(events(session, doctor)[0]["UID"]) == expected

    room = Room(code="W2", room_type=RoomType.W, site=Site.SHC)
    session.add(room)
    session.flush()
    row.room_id = room.id
    row.notes = "moved"
    session.commit()

    event = events(session, doctor)[0]
    assert str(event["UID"]) == expected
    assert str(event["SUMMARY"]) == "W2 — Session"


# --- timezone ------------------------------------------------------------


def test_times_are_emitted_as_utc_and_respect_bst(session, doctor):
    """The same wall-clock session is an hour apart in UTC across the BST
    boundary -- the assertion that catches a `zoneinfo` mistake."""
    summer = make_rota(session, start_date=datetime.date(2026, 6, 1))
    winter = make_rota(session, start_date=datetime.date(2026, 12, 7))
    add_session(session, summer, doctor)
    add_session(session, winter, doctor)

    starts = sorted(e["DTSTART"].dt for e in events(session, doctor))
    assert all(start.tzinfo is not None for start in starts)
    assert all(start.utcoffset() == datetime.timedelta(0) for start in starts)
    # AM_START is 08:30 local: 07:30Z under BST, 08:30Z under GMT.
    assert starts[0].hour == 7
    assert starts[1].hour == 8


# --- calendar-level properties -------------------------------------------


def test_calendar_headers(session, doctor):
    parsed = Calendar.from_ical(build_feed(session, doctor, TODAY))
    assert str(parsed["X-WR-CALNAME"]) == "ABC rota"
    assert str(parsed["X-WR-TIMEZONE"]) == "Europe/London"
    assert str(parsed["METHOD"]) == "PUBLISH"
    assert str(parsed["VERSION"]) == "2.0"


def test_refresh_hints_are_both_present_and_well_formed(session, doctor):
    raw = build_feed(session, doctor, TODAY).decode()
    assert "REFRESH-INTERVAL;VALUE=DURATION:PT12H" in raw
    assert "X-PUBLISHED-TTL:PT12H" in raw


def test_a_doctor_with_no_sessions_still_gets_a_valid_calendar(session, doctor):
    raw = build_feed(session, doctor, TODAY)
    assert raw.startswith(b"BEGIN:VCALENDAR")
    assert Calendar.from_ical(raw).walk("VEVENT") == []
