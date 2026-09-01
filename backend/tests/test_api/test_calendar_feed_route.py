"""Route tests for the public .ics feed (calendar feed plan, Task 3).

Every test here uses `client_no_auth`, never `client`. That is the whole
point: the `client` fixture overrides `get_current_user` wholesale, so a
test using it would pass whether or not the endpoint required a session and
would prove nothing about the one property this router exists to have.

The content of the feed is `tests/test_calendar_feed.py`'s business. These
tests cover the route: that it is reachable with no Authorization header,
that it answers as a calendar, that an unknown or rotated token is a plain
404, and that a token fetches exactly one doctor's sessions.
"""
import datetime

import pytest
from icalendar import Calendar

from app.models import Doctor
from app.models.enums import Day, DoctorType, MasterSessionType, Period, RotaStatus
from app.models.rota import GeneratedRota, RotaConfig, RotaSession

# The Monday of the current real week: the route calls `date.today()`, so
# the fixture data has to sit inside the feed's rolling history window
# relative to whenever the suite happens to run.
_TODAY = datetime.date.today()
_MONDAY = _TODAY - datetime.timedelta(days=_TODAY.weekday())

FEED = "/api/v1/calendar/{token}.ics"


def _make_doctor(db_session, code: str) -> Doctor:
    doctor = Doctor(code=code, doctor_type=DoctorType.PARTNER)
    db_session.add(doctor)
    db_session.commit()
    return doctor


def _committed_rota(db_session) -> GeneratedRota:
    config = RotaConfig(start_date=_MONDAY, num_weeks=1)
    db_session.add(config)
    db_session.flush()
    rota = GeneratedRota(config_id=config.id, status=RotaStatus.COMMITTED)
    db_session.add(rota)
    db_session.commit()
    return rota


def _add_session(db_session, rota, doctor, *, day=Day.MONDAY, period=Period.AM):
    db_session.add(RotaSession(
        rota_id=rota.id,
        doctor_id=doctor.id,
        week=1,
        day=day,
        period=period,
        template_type=MasterSessionType.REQUIRES_ROOM,
    ))
    db_session.commit()


def _summaries(body: bytes) -> list[str]:
    return [
        str(event["SUMMARY"]) for event in Calendar.from_ical(body).walk("VEVENT")
    ]


def test_valid_token_is_served_without_authentication(client_no_auth, db_session):
    doctor = _make_doctor(db_session, "ABC")
    rota = _committed_rota(db_session)
    _add_session(db_session, rota, doctor)

    resp = client_no_auth.get(FEED.format(token=doctor.calendar_token))

    assert resp.status_code == 200, resp.text
    assert resp.headers["content-type"].startswith("text/calendar")
    assert "charset=utf-8" in resp.headers["content-type"]
    assert resp.headers["content-disposition"] == 'inline; filename="rota.ics"'
    assert resp.content.startswith(b"BEGIN:VCALENDAR")
    assert len(_summaries(resp.content)) == 1


def test_feed_carries_only_its_own_doctors_sessions(client_no_auth, db_session):
    doctor_a = _make_doctor(db_session, "AAA")
    doctor_b = _make_doctor(db_session, "BBB")
    rota = _committed_rota(db_session)
    _add_session(db_session, rota, doctor_a, day=Day.MONDAY, period=Period.AM)
    _add_session(db_session, rota, doctor_b, day=Day.TUESDAY, period=Period.PM)

    resp = client_no_auth.get(FEED.format(token=doctor_a.calendar_token))

    assert resp.status_code == 200, resp.text
    calendar = Calendar.from_ical(resp.content)
    assert str(calendar["X-WR-CALNAME"]) == "AAA rota"
    events = list(calendar.walk("VEVENT"))
    assert len(events) == 1
    b_session_ids = {
        row.id for row in db_session.query(RotaSession)
        if row.doctor_id == doctor_b.id
    }
    uids = {str(event["UID"]) for event in events}
    assert not any(uid.split("@")[0] in {str(i) for i in b_session_ids} for uid in uids)


@pytest.mark.parametrize("token", ["nosuchtoken", "x" * 43])
def test_unknown_token_is_404(client_no_auth, db_session, token):
    _make_doctor(db_session, "ABC")

    resp = client_no_auth.get(FEED.format(token=token))

    assert resp.status_code == 404


def test_rotated_token_dead_ends_the_old_url(client_no_auth, db_session):
    doctor = _make_doctor(db_session, "ABC")
    old_token = doctor.calendar_token

    doctor.calendar_token = "rotated-" + old_token
    db_session.commit()

    assert client_no_auth.get(FEED.format(token=old_token)).status_code == 404
    assert client_no_auth.get(
        FEED.format(token=doctor.calendar_token)
    ).status_code == 200


def test_a_deactivated_doctor_still_serves_their_feed(client_no_auth, db_session):
    """Deactivation is not revocation -- rotation is (Decision 2), and a
    leaver's committed past sessions are real history."""
    doctor = _make_doctor(db_session, "ABC")
    rota = _committed_rota(db_session)
    _add_session(db_session, rota, doctor)
    doctor.active = False
    db_session.commit()

    resp = client_no_auth.get(FEED.format(token=doctor.calendar_token))

    assert resp.status_code == 200
    assert len(_summaries(resp.content)) == 1
