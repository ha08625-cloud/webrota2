"""Leave planning router tests (annual leave planning, Task 3).

The `seeded` fixture gives two doctors -- AA (Partner) and BB (Salaried) --
both REQUIRES_ROOM Monday AM and PM on template week 1, so the baseline
Monday headcount is 2 and every other weekday is 0.
"""
import datetime

import pytest

from app.models import (
    Doctor,
    ExtraSessionEntry,
    LeaveEntry,
    MasterRotaSession,
    MasterRotaTemplate,
    PracticeClosure,
    RotaSession,
    SystemCounter,
)
from app.models.enums import (
    Day,
    DoctorType,
    MasterSessionType,
    Period,
    SystemCounterType,
)

from .conftest import MONDAY, generate_rota

TUESDAY = MONDAY + datetime.timedelta(days=1)
SATURDAY = MONDAY + datetime.timedelta(days=5)

COVERAGE = "/api/v1/leave-planning/coverage"
BULK = "/api/v1/leave-planning/bulk"


def _coverage(client, from_date=MONDAY, to_date=MONDAY):
    resp = client.get(
        f"{COVERAGE}?from_date={from_date.isoformat()}&to_date={to_date.isoformat()}"
    )
    assert resp.status_code == 200, resp.text
    return {(e["date"], e["period"]): e for e in resp.json()}


def _add_template_row(db, seeded, doctor_id, day, period, session_type, room_id=None):
    db.add(MasterRotaSession(
        template_id=seeded["template"], doctor_id=doctor_id, week=1,
        day=day, period=period, session_type=session_type, room_id=room_id,
    ))
    db.commit()


def _set_template_type(db, seeded, doctor_id, day, period, session_type):
    row = db.query(MasterRotaSession).filter_by(
        template_id=seeded["template"], doctor_id=doctor_id,
        week=1, day=day, period=period,
    ).one()
    row.session_type = session_type
    db.commit()


def _add_doctor(db, code, doctor_type):
    doctor = Doctor(
        code=code, doctor_type=doctor_type, sessions_per_week=10, active=True
    )
    db.add(doctor)
    db.flush()
    for ct in (SystemCounterType.ROOM_MOVE, SystemCounterType.SUPERVISION):
        db.add(SystemCounter(doctor_id=doctor.id, counter_type=ct, raw_count=0))
    db.commit()
    return doctor.id


class TestCoverage:
    def test_template_week_one_headcount(self, client, seeded):
        slots = _coverage(client, MONDAY, TUESDAY)
        # Weekends are omitted entirely, so a Mon-Tue range is 4 slots.
        assert len(slots) == 4
        assert slots[(MONDAY.isoformat(), "AM")] == {
            "date": MONDAY.isoformat(), "period": "AM",
            "headcount": 2, "is_closed": False,
        }
        assert slots[(MONDAY.isoformat(), "PM")]["headcount"] == 2
        # No template row for Tuesday: absent counts as zero.
        assert slots[(TUESDAY.isoformat(), "AM")]["headcount"] == 0

    def test_weekends_omitted(self, client, seeded):
        slots = _coverage(client, MONDAY, MONDAY + datetime.timedelta(days=6))
        assert all(
            datetime.date.fromisoformat(d).weekday() <= 4 for d, _ in slots
        )
        assert len(slots) == 10  # 5 weekdays x AM/PM

    def test_leave_reduces_headcount(self, client, db_session, seeded):
        db_session.add(LeaveEntry(
            doctor_id=seeded["doctor_aa"], date=MONDAY, period=Period.AM,
        ))
        db_session.commit()

        slots = _coverage(client)
        assert slots[(MONDAY.isoformat(), "AM")]["headcount"] == 1
        assert slots[(MONDAY.isoformat(), "PM")]["headcount"] == 2

    def test_extra_session_on_no_surgery_increases_headcount(
        self, client, db_session, seeded
    ):
        _add_template_row(
            db_session, seeded, seeded["doctor_aa"], Day.TUESDAY, Period.AM,
            MasterSessionType.NO_SURGERY,
        )
        assert _coverage(client, TUESDAY, TUESDAY)[
            (TUESDAY.isoformat(), "AM")
        ]["headcount"] == 0

        db_session.add(ExtraSessionEntry(
            doctor_id=seeded["doctor_aa"], date=TUESDAY, period=Period.AM,
        ))
        db_session.commit()

        assert _coverage(client, TUESDAY, TUESDAY)[
            (TUESDAY.isoformat(), "AM")
        ]["headcount"] == 1

    def test_extra_session_with_no_template_row_increases_headcount(
        self, client, db_session, seeded
    ):
        """Absence is overridable too -- the copy loop's new-row branch."""
        db_session.add(ExtraSessionEntry(
            doctor_id=seeded["doctor_bb"], date=TUESDAY, period=Period.PM,
        ))
        db_session.commit()

        assert _coverage(client, TUESDAY, TUESDAY)[
            (TUESDAY.isoformat(), "PM")
        ]["headcount"] == 1

    def test_extra_session_on_requires_room_does_not_double_count(
        self, client, db_session, seeded
    ):
        """Design Decision 4: the override is conditional. A slot already
        REQUIRES_ROOM is untouched by the extra session -- the doctor was
        already working it -- so a flat +1 would over-count."""
        db_session.add(ExtraSessionEntry(
            doctor_id=seeded["doctor_aa"], date=MONDAY, period=Period.AM,
        ))
        db_session.commit()

        assert _coverage(client)[(MONDAY.isoformat(), "AM")]["headcount"] == 2

    def test_extra_session_does_not_override_leave(self, client, db_session, seeded):
        db_session.add(LeaveEntry(
            doctor_id=seeded["doctor_aa"], date=MONDAY, period=Period.AM,
        ))
        db_session.add(ExtraSessionEntry(
            doctor_id=seeded["doctor_aa"], date=MONDAY, period=Period.AM,
        ))
        db_session.commit()

        assert _coverage(client)[(MONDAY.isoformat(), "AM")]["headcount"] == 1

    @pytest.mark.parametrize("session_type", [
        MasterSessionType.ADMIN_TIME,
        MasterSessionType.WFH,
        MasterSessionType.NO_SURGERY,
    ])
    def test_non_clinical_types_do_not_count(
        self, client, db_session, seeded, session_type
    ):
        _set_template_type(
            db_session, seeded, seeded["doctor_aa"], Day.MONDAY, Period.AM,
            session_type,
        )
        assert _coverage(client)[(MONDAY.isoformat(), "AM")]["headcount"] == 1

    def test_pre_assigned_counts(self, client, db_session, seeded):
        _add_template_row(
            db_session, seeded, seeded["doctor_aa"], Day.TUESDAY, Period.AM,
            MasterSessionType.PRE_ASSIGNED, room_id=seeded["room_c1"],
        )
        assert _coverage(client, TUESDAY, TUESDAY)[
            (TUESDAY.isoformat(), "AM")
        ]["headcount"] == 1

    def test_closed_slot_reports_zero_and_is_closed(
        self, client, db_session, seeded
    ):
        db_session.add(PracticeClosure(date=MONDAY, period=Period.AM))
        db_session.commit()

        slots = _coverage(client)
        assert slots[(MONDAY.isoformat(), "AM")]["is_closed"] is True
        assert slots[(MONDAY.isoformat(), "AM")]["headcount"] == 0

    def test_half_day_closure_affects_only_its_own_period(
        self, client, db_session, seeded
    ):
        db_session.add(PracticeClosure(date=MONDAY, period=Period.AM))
        db_session.commit()

        slots = _coverage(client)
        assert slots[(MONDAY.isoformat(), "PM")]["is_closed"] is False
        assert slots[(MONDAY.isoformat(), "PM")]["headcount"] == 2

    def test_out_of_window_doctor_excluded_outside_included_inside(
        self, client, seeded
    ):
        next_monday = MONDAY + datetime.timedelta(days=7)
        resp = client.patch(f"/api/v1/doctors/{seeded['doctor_aa']}", json={
            "start_date": next_monday.isoformat(),
        })
        assert resp.status_code == 200, resp.text

        slots = _coverage(client, MONDAY, next_monday)
        assert slots[(MONDAY.isoformat(), "AM")]["headcount"] == 1
        assert slots[(next_monday.isoformat(), "AM")]["headcount"] == 2

    def test_inactive_doctor_excluded(self, client, db_session, seeded):
        doctor = db_session.get(Doctor, seeded["doctor_aa"])
        doctor.active = False
        db_session.commit()

        assert _coverage(client)[(MONDAY.isoformat(), "AM")]["headcount"] == 1

    @pytest.mark.parametrize("doctor_type", [
        DoctorType.TRAINEE, DoctorType.LOCUM, DoctorType.AHP,
    ])
    def test_non_planning_doctor_types_never_counted(
        self, client, db_session, seeded, doctor_type
    ):
        doctor_id = _add_doctor(db_session, f"X{doctor_type.value[:1]}", doctor_type)
        _add_template_row(
            db_session, seeded, doctor_id, Day.MONDAY, Period.AM,
            MasterSessionType.REQUIRES_ROOM,
        )
        assert _coverage(client)[(MONDAY.isoformat(), "AM")]["headcount"] == 2

    def test_range_cap_422(self, client, seeded):
        resp = client.get(
            f"{COVERAGE}?from_date={MONDAY.isoformat()}"
            f"&to_date={(MONDAY + datetime.timedelta(days=63)).isoformat()}"
        )
        assert resp.status_code == 422
        assert "62 days" in resp.json()["detail"]

    def test_range_at_cap_ok(self, client, seeded):
        resp = client.get(
            f"{COVERAGE}?from_date={MONDAY.isoformat()}"
            f"&to_date={(MONDAY + datetime.timedelta(days=62)).isoformat()}"
        )
        assert resp.status_code == 200, resp.text

    def test_reversed_range_422(self, client, seeded):
        resp = client.get(
            f"{COVERAGE}?from_date={TUESDAY.isoformat()}&to_date={MONDAY.isoformat()}"
        )
        assert resp.status_code == 422

    def test_no_active_template_returns_zeros(self, client, db_session, seeded):
        template = db_session.get(MasterRotaTemplate, seeded["template"])
        template.is_active = False
        db_session.commit()

        slots = _coverage(client)
        assert slots[(MONDAY.isoformat(), "AM")]["headcount"] == 0
        assert slots[(MONDAY.isoformat(), "AM")]["is_closed"] is False

    def test_two_active_templates_resolve_to_lowest_id(
        self, client, db_session, seeded
    ):
        """is_active is not schema-enforced unique, so a second active row
        must resolve deterministically rather than 500."""
        db_session.add(MasterRotaTemplate(name="Second", is_active=True))
        db_session.commit()

        assert _coverage(client)[(MONDAY.isoformat(), "AM")]["headcount"] == 2


class TestBulk:
    def test_mixed_batch_applies(self, client, db_session, seeded):
        resp = client.post(BULK, json={"actions": [
            {"doctor_id": seeded["doctor_aa"], "date": MONDAY.isoformat(),
             "period": "AM", "action": "leave"},
            {"doctor_id": seeded["doctor_bb"], "date": TUESDAY.isoformat(),
             "period": "PM", "action": "extra_session"},
        ]})
        assert resp.status_code == 200, resp.text
        body = resp.json()
        assert body["applied"] == 2
        assert body["skipped"] == []
        assert body["superseded_extra_sessions"] == []

        assert db_session.query(LeaveEntry).count() == 1
        assert db_session.query(ExtraSessionEntry).count() == 1

    def test_empty_batch_is_a_no_op(self, client, seeded):
        resp = client.post(BULK, json={"actions": []})
        assert resp.status_code == 200, resp.text
        assert resp.json()["applied"] == 0

    def test_leave_wins_over_extra_session_on_the_same_cell(
        self, client, db_session, seeded
    ):
        resp = client.post(BULK, json={"actions": [
            {"doctor_id": seeded["doctor_aa"], "date": MONDAY.isoformat(),
             "period": "AM", "action": "extra_session"},
            {"doctor_id": seeded["doctor_aa"], "date": MONDAY.isoformat(),
             "period": "AM", "action": "leave"},
        ]})
        assert resp.status_code == 200, resp.text
        body = resp.json()
        assert body["applied"] == 1
        assert [s["reason"] for s in body["skipped"]] == ["leave_exists"]
        assert body["skipped"][0]["action"] == "extra_session"

        assert db_session.query(LeaveEntry).count() == 1
        assert db_session.query(ExtraSessionEntry).count() == 0

    def test_duplicate_leave_is_skipped_not_409(self, client, db_session, seeded):
        db_session.add(LeaveEntry(
            doctor_id=seeded["doctor_aa"], date=MONDAY, period=Period.AM,
        ))
        db_session.commit()

        resp = client.post(BULK, json={"actions": [
            {"doctor_id": seeded["doctor_aa"], "date": MONDAY.isoformat(),
             "period": "AM", "action": "leave"},
        ]})
        assert resp.status_code == 200, resp.text
        body = resp.json()
        assert body["applied"] == 0
        assert [s["reason"] for s in body["skipped"]] == ["duplicate"]
        assert db_session.query(LeaveEntry).count() == 1

    def test_duplicate_extra_session_is_skipped_not_409(
        self, client, db_session, seeded
    ):
        db_session.add(ExtraSessionEntry(
            doctor_id=seeded["doctor_aa"], date=MONDAY, period=Period.AM,
        ))
        db_session.commit()

        resp = client.post(BULK, json={"actions": [
            {"doctor_id": seeded["doctor_aa"], "date": MONDAY.isoformat(),
             "period": "AM", "action": "extra_session"},
        ]})
        assert resp.status_code == 200, resp.text
        assert [s["reason"] for s in resp.json()["skipped"]] == ["duplicate"]

    def test_repeated_identical_action_in_one_batch_is_a_duplicate(
        self, client, db_session, seeded
    ):
        action = {
            "doctor_id": seeded["doctor_aa"], "date": MONDAY.isoformat(),
            "period": "AM", "action": "leave",
        }
        resp = client.post(BULK, json={"actions": [action, action]})
        assert resp.status_code == 200, resp.text
        body = resp.json()
        assert body["applied"] == 1
        assert [s["reason"] for s in body["skipped"]] == ["duplicate"]
        assert db_session.query(LeaveEntry).count() == 1

    def test_clear_removes_both_rows(self, client, db_session, seeded):
        db_session.add(LeaveEntry(
            doctor_id=seeded["doctor_aa"], date=MONDAY, period=Period.AM,
        ))
        db_session.add(ExtraSessionEntry(
            doctor_id=seeded["doctor_aa"], date=MONDAY, period=Period.AM,
        ))
        db_session.commit()

        resp = client.post(BULK, json={"actions": [
            {"doctor_id": seeded["doctor_aa"], "date": MONDAY.isoformat(),
             "period": "AM", "action": "clear"},
        ]})
        assert resp.status_code == 200, resp.text
        assert resp.json()["applied"] == 1

        assert db_session.query(LeaveEntry).count() == 0
        assert db_session.query(ExtraSessionEntry).count() == 0

    def test_clear_of_an_empty_cell_is_skipped(self, client, seeded):
        resp = client.post(BULK, json={"actions": [
            {"doctor_id": seeded["doctor_aa"], "date": MONDAY.isoformat(),
             "period": "AM", "action": "clear"},
        ]})
        assert resp.status_code == 200, resp.text
        body = resp.json()
        assert body["applied"] == 0
        assert [s["reason"] for s in body["skipped"]] == ["nothing_to_clear"]

    def test_clear_then_leave_on_the_same_cell(self, client, db_session, seeded):
        """Clears run first, so this is a legal batch and must not collide
        on the unique constraint."""
        db_session.add(ExtraSessionEntry(
            doctor_id=seeded["doctor_aa"], date=MONDAY, period=Period.AM,
        ))
        db_session.commit()

        resp = client.post(BULK, json={"actions": [
            {"doctor_id": seeded["doctor_aa"], "date": MONDAY.isoformat(),
             "period": "AM", "action": "leave"},
            {"doctor_id": seeded["doctor_aa"], "date": MONDAY.isoformat(),
             "period": "AM", "action": "clear"},
        ]})
        assert resp.status_code == 200, resp.text
        body = resp.json()
        assert body["applied"] == 2
        assert body["skipped"] == []
        # The extra session was cleared before the leave landed, so there
        # was nothing left for the leave to supersede.
        assert body["superseded_extra_sessions"] == []
        assert db_session.query(LeaveEntry).count() == 1
        assert db_session.query(ExtraSessionEntry).count() == 0

    def test_out_of_window_action_is_skipped_and_the_rest_applies(
        self, client, db_session, seeded
    ):
        resp = client.patch(f"/api/v1/doctors/{seeded['doctor_aa']}", json={
            "start_date": (MONDAY + datetime.timedelta(days=7)).isoformat(),
        })
        assert resp.status_code == 200, resp.text

        resp = client.post(BULK, json={"actions": [
            {"doctor_id": seeded["doctor_aa"], "date": MONDAY.isoformat(),
             "period": "AM", "action": "leave"},
            {"doctor_id": seeded["doctor_aa"], "date": MONDAY.isoformat(),
             "period": "PM", "action": "extra_session"},
            {"doctor_id": seeded["doctor_bb"], "date": MONDAY.isoformat(),
             "period": "AM", "action": "leave"},
        ]})
        assert resp.status_code == 200, resp.text
        body = resp.json()
        assert body["applied"] == 1
        assert {s["reason"] for s in body["skipped"]} == {"outside_doctor_dates"}
        assert len(body["skipped"]) == 2

        entries = db_session.query(LeaveEntry).all()
        assert [e.doctor_id for e in entries] == [seeded["doctor_bb"]]
        assert db_session.query(ExtraSessionEntry).count() == 0

    def test_superseded_extra_sessions_reported_and_kept(
        self, client, db_session, seeded
    ):
        db_session.add(ExtraSessionEntry(
            doctor_id=seeded["doctor_aa"], date=MONDAY, period=Period.AM,
        ))
        db_session.commit()

        resp = client.post(BULK, json={"actions": [
            {"doctor_id": seeded["doctor_aa"], "date": MONDAY.isoformat(),
             "period": "AM", "action": "leave"},
        ]})
        assert resp.status_code == 200, resp.text
        body = resp.json()
        assert len(body["superseded_extra_sessions"]) == 1
        assert body["superseded_extra_sessions"][0]["date"] == MONDAY.isoformat()

        # Reported, never deleted.
        assert db_session.query(ExtraSessionEntry).count() == 1

    def test_weekend_action_422(self, client, db_session, seeded):
        resp = client.post(BULK, json={"actions": [
            {"doctor_id": seeded["doctor_aa"], "date": MONDAY.isoformat(),
             "period": "AM", "action": "leave"},
            {"doctor_id": seeded["doctor_aa"], "date": SATURDAY.isoformat(),
             "period": "AM", "action": "leave"},
        ]})
        assert resp.status_code == 422
        assert "weekend" in resp.json()["detail"]
        assert db_session.query(LeaveEntry).count() == 0

    def test_unknown_doctor_404s_the_whole_batch(self, client, db_session, seeded):
        resp = client.post(BULK, json={"actions": [
            {"doctor_id": seeded["doctor_aa"], "date": MONDAY.isoformat(),
             "period": "AM", "action": "leave"},
            {"doctor_id": 999999, "date": MONDAY.isoformat(),
             "period": "PM", "action": "leave"},
        ]})
        assert resp.status_code == 404
        assert db_session.query(LeaveEntry).count() == 0

    def test_batch_size_cap_422(self, client, seeded):
        action = {
            "doctor_id": seeded["doctor_aa"], "date": MONDAY.isoformat(),
            "period": "AM", "action": "leave",
        }
        resp = client.post(BULK, json={"actions": [action] * 2001})
        assert resp.status_code == 422

    def test_trainee_is_a_legal_bulk_target(self, client, db_session, seeded):
        """The write path is generic (Design Decision 2) -- only the
        coverage read is doctor-type filtered."""
        trainee_id = _add_doctor(db_session, "TT", DoctorType.TRAINEE)

        resp = client.post(BULK, json={"actions": [
            {"doctor_id": trainee_id, "date": MONDAY.isoformat(),
             "period": "AM", "action": "leave"},
        ]})
        assert resp.status_code == 200, resp.text
        assert resp.json()["applied"] == 1


class TestBulkReleasesDraftRooms:
    def _draft_session(self, db, seeded, period=Period.AM):
        return db.query(RotaSession).filter_by(
            doctor_id=seeded["doctor_aa"], week=1, day=Day.MONDAY, period=period,
        ).one()

    def test_leave_clears_the_draft_room(self, client, db_session, seeded):
        generate_rota(client)
        session = self._draft_session(db_session, seeded)
        session.room_id = seeded["room_c1"]
        db_session.commit()

        resp = client.post(BULK, json={"actions": [
            {"doctor_id": seeded["doctor_aa"], "date": MONDAY.isoformat(),
             "period": "AM", "action": "leave"},
        ]})
        assert resp.status_code == 200, resp.text

        db_session.expire_all()
        assert self._draft_session(db_session, seeded).room_id is None

    def test_duplicate_leave_still_releases_the_room(
        self, client, db_session, seeded
    ):
        """The deliberate over-call documented in routers/leave.py: an
        all-duplicates request still heals stale room state."""
        generate_rota(client)
        db_session.add(LeaveEntry(
            doctor_id=seeded["doctor_aa"], date=MONDAY, period=Period.AM,
        ))
        session = self._draft_session(db_session, seeded)
        session.room_id = seeded["room_c1"]
        db_session.commit()

        resp = client.post(BULK, json={"actions": [
            {"doctor_id": seeded["doctor_aa"], "date": MONDAY.isoformat(),
             "period": "AM", "action": "leave"},
        ]})
        assert resp.status_code == 200, resp.text
        assert [s["reason"] for s in resp.json()["skipped"]] == ["duplicate"]

        db_session.expire_all()
        assert self._draft_session(db_session, seeded).room_id is None

    def test_clear_does_not_restore_the_room(self, client, db_session, seeded):
        """Asymmetric by design (Design Decision 10), matching
        /leave/bulk-delete and the WFH behaviour."""
        generate_rota(client)
        db_session.add(LeaveEntry(
            doctor_id=seeded["doctor_aa"], date=MONDAY, period=Period.AM,
        ))
        session = self._draft_session(db_session, seeded)
        session.room_id = None
        db_session.commit()

        resp = client.post(BULK, json={"actions": [
            {"doctor_id": seeded["doctor_aa"], "date": MONDAY.isoformat(),
             "period": "AM", "action": "clear"},
        ]})
        assert resp.status_code == 200, resp.text

        db_session.expire_all()
        assert self._draft_session(db_session, seeded).room_id is None
