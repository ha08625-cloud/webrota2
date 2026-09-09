"""Tests for GET /leave/chargeable-count (no-surgery leave exemption plan,
Task 3). The pure rule itself is covered by
`tests/test_engine/test_leave_charging.py`; this file only exercises the
HTTP plumbing -- doctor lookup, date validation, and wiring the DB-loaded
template/closure state into `summarise_leave_charging`.

The `seeded` fixture gives doctor AA a REQUIRES_ROOM template row on Monday
AM/PM only (see test_api/conftest.py), so any other weekday has no
template row at all.
"""
import datetime

from app.models import LeaveEntry, PracticeClosure
from app.models.enums import Period

from .conftest import MONDAY

TUESDAY = MONDAY + datetime.timedelta(days=1)
SATURDAY = MONDAY + datetime.timedelta(days=5)

URL = "/api/v1/leave/chargeable-count"


def _get(client, doctor_id, from_date, to_date):
    return client.get(
        f"{URL}?doctor_id={doctor_id}&from_date={from_date.isoformat()}"
        f"&to_date={to_date.isoformat()}"
    )


def test_unknown_doctor_404(client, seeded):
    resp = _get(client, 999999, MONDAY, MONDAY)
    assert resp.status_code == 404
    assert resp.json()["detail"] == "Doctor 999999 not found"


def test_inactive_doctor_is_not_404d(client, db_session, seeded):
    """an inactive doctor's historical leave is still
    historical leave, so this endpoint must use db.get, not a query
    filtered on Doctor.active."""
    from app.models import Doctor

    doctor = db_session.get(Doctor, seeded["doctor_aa"])
    doctor.active = False
    db_session.commit()

    resp = _get(client, seeded["doctor_aa"], MONDAY, MONDAY)
    assert resp.status_code == 200


def test_from_after_to_is_422(client, seeded):
    resp = _get(client, seeded["doctor_aa"], MONDAY, MONDAY - datetime.timedelta(days=1))
    assert resp.status_code == 422
    assert resp.json()["detail"] == "from_date must not be after to_date"


def test_range_over_max_is_422(client, seeded):
    resp = _get(
        client, seeded["doctor_aa"], MONDAY, MONDAY + datetime.timedelta(days=367)
    )
    assert resp.status_code == 422
    assert "366" in resp.json()["detail"]


def test_no_leave_entries_is_all_zero(client, seeded):
    resp = _get(client, seeded["doctor_aa"], MONDAY, MONDAY)
    assert resp.status_code == 200
    body = resp.json()
    assert body["total_entries"] == 0
    assert body["chargeable_sessions"] == 0
    assert body["exempt_sessions"] == 0
    assert body["exempt_by_reason"] == {
        "closed": 0, "weekend": 0, "no_template_row": 0, "no_surgery": 0,
    }


def test_breakdown_across_reasons(client, db_session, seeded):
    doctor_id = seeded["doctor_aa"]
    # Chargeable: Monday AM has a REQUIRES_ROOM template row.
    db_session.add(LeaveEntry(doctor_id=doctor_id, date=MONDAY, period=Period.AM))
    # Exempt, no_template_row: Tuesday has no week-1 row for this doctor.
    db_session.add(LeaveEntry(doctor_id=doctor_id, date=TUESDAY, period=Period.AM))
    # Exempt, weekend.
    db_session.add(LeaveEntry(doctor_id=doctor_id, date=SATURDAY, period=Period.AM))
    # Exempt, closed: Monday PM is a working slot, but closed here.
    db_session.add(LeaveEntry(doctor_id=doctor_id, date=MONDAY, period=Period.PM))
    db_session.add(PracticeClosure(date=MONDAY, period=Period.PM, name="Test closure"))
    db_session.commit()

    resp = _get(client, doctor_id, MONDAY, SATURDAY)
    assert resp.status_code == 200
    body = resp.json()

    assert body["doctor_id"] == doctor_id
    assert body["from_date"] == MONDAY.isoformat()
    assert body["to_date"] == SATURDAY.isoformat()
    assert body["total_entries"] == 4
    assert body["chargeable_sessions"] == 1
    assert body["exempt_sessions"] == 3
    assert body["exempt_by_reason"] == {
        "closed": 1, "weekend": 1, "no_template_row": 1, "no_surgery": 0,
    }
    assert (
        body["chargeable_sessions"] + sum(body["exempt_by_reason"].values())
        == body["total_entries"]
    )


def test_only_the_requested_doctors_entries_are_counted(client, db_session, seeded):
    """Both AA and BB have a chargeable Monday AM slot; the query for
    doctor_id=AA must not pick up BB's entry."""
    db_session.add(LeaveEntry(
        doctor_id=seeded["doctor_aa"], date=MONDAY, period=Period.AM,
    ))
    db_session.add(LeaveEntry(
        doctor_id=seeded["doctor_bb"], date=MONDAY, period=Period.AM,
    ))
    db_session.commit()

    body = _get(client, seeded["doctor_aa"], MONDAY, MONDAY).json()
    assert body["total_entries"] == 1
    assert body["chargeable_sessions"] == 1
