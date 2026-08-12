"""Tests for /leave/entitlement (leave entitlement and balances plan).

The rules themselves are covered by
`tests/test_engine/test_leave_entitlement.py`; this file covers HTTP
behaviour, which doctors appear, and the wiring of stored rows and leave
usage into the response.

The `seeded` fixture gives AA (Partner, 10 sessions/week) and BB (Salaried,
10) a REQUIRES_ROOM template row on Monday AM/PM only, so any other weekday
is `no_template_row` and every non-Monday leave slot is exempt. MONDAY is
2026-01-05, so the fixture's leave year is 2026 throughout.
"""
import datetime
from decimal import Decimal

from app.models import Doctor, LeaveEntitlement, LeaveEntry, PracticeClosure
from app.models.enums import DoctorType, Period

from .conftest import MONDAY

URL = "/api/v1/leave/entitlement"
YEAR = MONDAY.year


def _list(client, year=YEAR):
    return client.get(f"{URL}?year={year}")


def _by_code(body):
    return {d["doctor_code"]: d for d in body["doctors"]}


def _add_leave(db_session, doctor_id, *days, period=None):
    for day in days:
        for p in ([period] if period else [Period.AM, Period.PM]):
            db_session.add(LeaveEntry(doctor_id=doctor_id, date=day, period=p))
    db_session.commit()


# --- The year window -------------------------------------------------------

def test_year_defaults_to_the_current_year(client, seeded):
    resp = client.get(URL)
    assert resp.status_code == 200
    assert resp.json()["year"] == datetime.date.today().year


def test_year_resolves_to_january_to_december(client, seeded):
    body = _list(client, 2026).json()
    assert body["from_date"] == "2026-01-01"
    assert body["to_date"] == "2026-12-31"


def test_absurd_year_is_422(client, seeded):
    assert _list(client, 1899).status_code == 422
    assert _list(client, 3000).status_code == 422


# --- Which doctors appear --------------------------------------------------

def test_lists_entitled_doctors(client, seeded):
    body = _list(client).json()
    assert set(_by_code(body)) == {"AA", "BB"}


def test_ahps_and_locums_are_omitted(client, db_session, seeded):
    """Their leave is not the practice's to reconcile, so a row for one is
    noise on a screen whose job is spotting who is over or under."""
    db_session.add_all([
        Doctor(code="AH", doctor_type=DoctorType.AHP, sessions_per_week=8, active=True),
        Doctor(code="LO", doctor_type=DoctorType.LOCUM, sessions_per_week=8, active=True),
    ])
    db_session.commit()

    assert set(_by_code(_list(client).json())) == {"AA", "BB"}


def test_inactive_doctor_without_leave_is_omitted(client, db_session, seeded):
    db_session.get(Doctor, seeded["doctor_bb"]).active = False
    db_session.commit()

    assert set(_by_code(_list(client).json())) == {"AA"}


def test_inactive_doctor_with_leave_in_the_year_is_included(client, db_session, seeded):
    """A doctor who left is still owed an accurate figure for the year they
    left in; hiding them would make that year's totals stop adding up."""
    _add_leave(db_session, seeded["doctor_bb"], MONDAY)
    db_session.get(Doctor, seeded["doctor_bb"]).active = False
    db_session.commit()

    body = _by_code(_list(client).json())
    assert body["BB"]["used_sessions"] == 2


def test_inactive_doctor_drops_out_of_a_year_they_booked_no_leave_in(
    client, db_session, seeded
):
    _add_leave(db_session, seeded["doctor_bb"], MONDAY)
    db_session.get(Doctor, seeded["doctor_bb"]).active = False
    db_session.commit()

    assert set(_by_code(_list(client, YEAR + 1).json())) == {"AA"}


# --- The entitlement figure ------------------------------------------------

def test_partner_gets_seven_weeks_salaried_six(client, seeded):
    body = _by_code(_list(client).json())
    assert body["AA"]["weeks"] == "7"
    assert body["AA"]["entitlement_sessions"] == "70.0"
    assert body["BB"]["weeks"] == "6"
    assert body["BB"]["entitlement_sessions"] == "60.0"


def test_entitlement_follows_sessions_per_week(client, db_session, seeded):
    db_session.get(Doctor, seeded["doctor_bb"]).sessions_per_week = Decimal("6")
    db_session.commit()

    assert _by_code(_list(client).json())["BB"]["entitlement_sessions"] == "36.0"


def test_part_year_doctor_is_pro_rated(client, db_session, seeded):
    db_session.get(Doctor, seeded["doctor_bb"]).start_date = datetime.date(YEAR, 7, 1)
    db_session.commit()

    row = _by_code(_list(client).json())["BB"]
    assert row["full_year_sessions"] == "60.0"
    assert row["rule_sessions"] == "30.2"  # 60 x 184/365
    assert row["entitlement_sessions"] == "30.2"


# --- Usage and balance -----------------------------------------------------

def test_used_counts_chargeable_sessions_only(client, db_session, seeded):
    """A Monday is template-backed and charges; the Tuesday has no template
    row and does not. `booked_sessions` still reports both."""
    tuesday = MONDAY + datetime.timedelta(days=1)
    _add_leave(db_session, seeded["doctor_aa"], MONDAY, tuesday)

    row = _by_code(_list(client).json())["AA"]
    assert row["booked_sessions"] == 4
    assert row["used_sessions"] == 2
    assert row["exempt_by_reason"]["no_template_row"] == 2
    assert row["remaining_sessions"] == "68.0"


def test_leave_outside_the_year_is_not_counted(client, db_session, seeded):
    _add_leave(db_session, seeded["doctor_aa"], datetime.date(YEAR - 1, 12, 29))
    _add_leave(db_session, seeded["doctor_aa"], datetime.date(YEAR + 1, 1, 4))

    row = _by_code(_list(client).json())["AA"]
    assert row["booked_sessions"] == 0
    assert row["used_sessions"] == 0


def test_year_boundaries_are_inclusive(client, db_session, seeded):
    """1 January and 31 December both fall inside the leave year. Neither
    2026 date has a Monday template row, so they land in booked, not used."""
    _add_leave(db_session, seeded["doctor_aa"], datetime.date(YEAR, 1, 1), period=Period.AM)
    _add_leave(db_session, seeded["doctor_aa"], datetime.date(YEAR, 12, 31), period=Period.AM)

    assert _by_code(_list(client).json())["AA"]["booked_sessions"] == 2


def test_another_doctors_leave_is_not_counted(client, db_session, seeded):
    _add_leave(db_session, seeded["doctor_bb"], MONDAY)

    body = _by_code(_list(client).json())
    assert body["AA"]["booked_sessions"] == 0
    assert body["BB"]["booked_sessions"] == 2


def test_closure_on_a_working_slot_is_exempt(client, db_session, seeded):
    """A bank holiday the doctor would have worked does not charge, which is
    how bank holidays come out free without any separate modelling."""
    db_session.add_all([
        PracticeClosure(date=MONDAY, period=Period.AM),
        PracticeClosure(date=MONDAY, period=Period.PM),
    ])
    _add_leave(db_session, seeded["doctor_aa"], MONDAY)

    row = _by_code(_list(client).json())["AA"]
    assert row["used_sessions"] == 0
    assert row["exempt_by_reason"]["closed"] == 2
    assert row["remaining_sessions"] == "70.0"


def test_remaining_can_go_negative(client, db_session, seeded):
    """An over-booked doctor reads negative rather than clamping at zero --
    the whole point of the screen is spotting exactly this."""
    db_session.get(Doctor, seeded["doctor_aa"]).sessions_per_week = Decimal("1")
    db_session.commit()
    _add_leave(db_session, seeded["doctor_aa"], MONDAY)
    _add_leave(db_session, seeded["doctor_aa"], MONDAY + datetime.timedelta(days=7))
    _add_leave(db_session, seeded["doctor_aa"], MONDAY + datetime.timedelta(days=14))
    _add_leave(db_session, seeded["doctor_aa"], MONDAY + datetime.timedelta(days=21))

    row = _by_code(_list(client).json())["AA"]
    assert row["entitlement_sessions"] == "7.0"
    assert row["used_sessions"] == 8
    assert row["remaining_sessions"] == "-1.0"


# --- The sessions_per_week / template mismatch warning ---------------------

def test_mismatch_is_flagged_when_the_template_disagrees(client, seeded):
    """AA has sessions_per_week=10 but only two week-1 template rows, so
    leave is charged against 2 sessions a week and credited against 10."""
    row = _by_code(_list(client).json())["AA"]
    assert row["template_sessions_per_week"] == 2
    assert row["sessions_mismatch"] is True


def test_no_mismatch_when_the_two_agree(client, db_session, seeded):
    db_session.get(Doctor, seeded["doctor_aa"]).sessions_per_week = Decimal("2")
    db_session.commit()

    row = _by_code(_list(client).json())["AA"]
    assert row["sessions_mismatch"] is False


def test_unpopulated_template_is_not_reported_as_a_mismatch(
    client, db_session, seeded
):
    """An empty template is reported through no_template_row instead, which
    is the more precise complaint."""
    from app.models import MasterRotaSession

    db_session.query(MasterRotaSession).delete()
    db_session.commit()
    _add_leave(db_session, seeded["doctor_aa"], MONDAY)

    row = _by_code(_list(client).json())["AA"]
    assert row["template_sessions_per_week"] == 0
    assert row["sessions_mismatch"] is False
    assert row["exempt_by_reason"]["no_template_row"] == 2


# --- Single-doctor read ----------------------------------------------------

def test_get_one_doctor(client, seeded):
    resp = client.get(f"{URL}/{seeded['doctor_aa']}?year={YEAR}")
    assert resp.status_code == 200
    assert resp.json()["doctor_code"] == "AA"


def test_get_unknown_doctor_404(client, seeded):
    assert client.get(f"{URL}/999999").status_code == 404


def test_get_ahp_returns_nulls_rather_than_404(client, db_session, seeded):
    """Asked about a specific AHP, the honest answer is null entitlement,
    not a 404 that reads as "no such doctor"."""
    ahp = Doctor(code="AH", doctor_type=DoctorType.AHP, sessions_per_week=8, active=True)
    db_session.add(ahp)
    db_session.commit()

    body = client.get(f"{URL}/{ahp.id}?year={YEAR}").json()
    assert body["weeks"] is None
    assert body["entitlement_sessions"] is None
    assert body["remaining_sessions"] is None


# --- Stored rows -----------------------------------------------------------

def test_put_stores_an_override(client, db_session, seeded):
    resp = client.put(
        f"{URL}/{seeded['doctor_aa']}?year={YEAR}",
        json={"entitlement_sessions": "50.0", "notes": "agreed at appraisal"},
    )
    assert resp.status_code == 200
    body = resp.json()
    assert body["rule_sessions"] == "70.0"
    assert body["override_sessions"] == "50.0"
    assert body["entitlement_sessions"] == "50.0"
    assert body["notes"] == "agreed at appraisal"

    assert _by_code(_list(client).json())["AA"]["entitlement_sessions"] == "50.0"


def test_put_stores_carry_over_and_adjustment(client, seeded):
    resp = client.put(
        f"{URL}/{seeded['doctor_aa']}?year={YEAR}",
        json={"carry_over_sessions": "4.0", "adjustment_sessions": "-2.0"},
    )
    body = resp.json()
    assert body["override_sessions"] is None
    assert body["carry_over_sessions"] == "4.0"
    assert body["adjustment_sessions"] == "-2.0"
    assert body["entitlement_sessions"] == "72.0"


def test_carry_over_only_row_still_tracks_the_rule(client, db_session, seeded):
    """The override is null, so changing sessions_per_week still moves the
    figure -- the reason carry-over and override are separate columns."""
    client.put(f"{URL}/{seeded['doctor_aa']}?year={YEAR}", json={"carry_over_sessions": "4.0"})
    db_session.get(Doctor, seeded["doctor_aa"]).sessions_per_week = Decimal("6")
    db_session.commit()

    assert _by_code(_list(client).json())["AA"]["entitlement_sessions"] == "46.0"


def test_put_is_a_full_replace(client, seeded):
    client.put(
        f"{URL}/{seeded['doctor_aa']}?year={YEAR}",
        json={"entitlement_sessions": "50.0", "carry_over_sessions": "4.0"},
    )
    body = client.put(f"{URL}/{seeded['doctor_aa']}?year={YEAR}", json={}).json()
    assert body["override_sessions"] is None
    assert body["carry_over_sessions"] == "0.0"
    assert body["entitlement_sessions"] == "70.0"


def test_put_is_scoped_to_one_year(client, seeded):
    client.put(f"{URL}/{seeded['doctor_aa']}?year={YEAR}", json={"carry_over_sessions": "4.0"})

    assert _by_code(_list(client, YEAR + 1).json())["AA"]["entitlement_sessions"] == "70.0"


def test_put_on_an_ahp_is_422(client, db_session, seeded):
    ahp = Doctor(code="AH", doctor_type=DoctorType.AHP, sessions_per_week=8, active=True)
    db_session.add(ahp)
    db_session.commit()

    resp = client.put(f"{URL}/{ahp.id}?year={YEAR}", json={"carry_over_sessions": "4.0"})
    assert resp.status_code == 422
    assert "no leave entitlement" in resp.json()["detail"]


def test_put_unknown_doctor_404(client, seeded):
    assert client.put(f"{URL}/999999?year={YEAR}", json={}).status_code == 404


def test_put_rejects_more_than_one_decimal_place(client, seeded):
    resp = client.put(
        f"{URL}/{seeded['doctor_aa']}?year={YEAR}",
        json={"entitlement_sessions": "50.25"},
    )
    assert resp.status_code == 422


def test_put_rejects_a_negative_override(client, seeded):
    resp = client.put(
        f"{URL}/{seeded['doctor_aa']}?year={YEAR}",
        json={"entitlement_sessions": "-1.0"},
    )
    assert resp.status_code == 422


def test_delete_reverts_to_the_rule(client, db_session, seeded):
    client.put(f"{URL}/{seeded['doctor_aa']}?year={YEAR}", json={"entitlement_sessions": "50.0"})

    resp = client.delete(f"{URL}/{seeded['doctor_aa']}?year={YEAR}")
    assert resp.status_code == 204
    assert _by_code(_list(client).json())["AA"]["entitlement_sessions"] == "70.0"
    assert (
        db_session.query(LeaveEntitlement)
        .filter_by(doctor_id=seeded["doctor_aa"], year=YEAR)
        .count()
        == 0
    )


def test_delete_without_a_stored_row_is_404(client, seeded):
    """404 rather than a silent success -- this deletes a record, and
    reporting success would hide a wrong year in the request."""
    assert client.delete(f"{URL}/{seeded['doctor_aa']}?year={YEAR}").status_code == 404
