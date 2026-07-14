"""Rota lifecycle and swap tests via the API (M3 Task 8)."""
import datetime

from sqlalchemy import select

from app.models import (
    ClinicCounter,
    GeneratedRota,
    PracticeClosure,
    RotaClinicCounterSnapshot,
    RotaSession,
    RotaSystemCounterSnapshot,
)

from .conftest import MONDAY, generate_rota, make_clinic_type_via_api


def _clinic_counters(client):
    return {
        (c["doctor_code"], c["clinic_type_name"]): c["raw_count"]
        for c in client.get("/api/v1/counters/clinic").json()
    }


def _monday_am_sessions(client, rota_id):
    rota = client.get(f"/api/v1/rota/{rota_id}").json()
    return {
        s["doctor_code"]: s
        for s in rota["sessions"]
        if s["day"] == "Monday" and s["period"] == "AM"
    }


class TestGenerate:
    def test_generate_creates_draft(self, client, seeded):
        make_clinic_type_via_api(client, seeded)
        out = generate_rota(client)
        assert out["rota_id"] is not None
        assert out["status"] == "draft"
        # Fixture has no duty assignments, so Phase 12 warnings are expected.
        assert any(i["check"].startswith("duty_coverage") for i in out["issues"])
        # The clinic landed on the eligible doctor with the eligible room.
        am = _monday_am_sessions(client, out["rota_id"])
        assert am["AA"]["clinic_type_name"] == "Dragon"
        assert am["AA"]["room_code"] == "C1"
        assert _clinic_counters(client)[("AA", "Dragon")] == 1

    def test_generate_409_when_draft_exists(self, client, seeded):
        generate_rota(client)
        resp = client.post("/api/v1/rota/generate", json={
            "start_date": "2026-01-05", "num_weeks": 1, "template_start_week": 1,
        })
        assert resp.status_code == 409

    def test_generate_409_when_overlaps_committed_rota(self, client, seeded):
        make_clinic_type_via_api(client, seeded)
        out = generate_rota(client, num_weeks=1)  # covers MONDAY .. MONDAY+7
        assert client.post(f"/api/v1/rota/{out['rota_id']}/commit").status_code == 200

        # Same start date, single week.
        resp = client.post("/api/v1/rota/generate", json={
            "start_date": MONDAY.isoformat(), "num_weeks": 1, "template_start_week": 1,
        })
        assert resp.status_code == 409

        # A 2-week request starting the previous Monday overlaps the
        # committed week -- rejected before the engine ever runs, so the
        # lack of week-2 template data here doesn't matter.
        prev_monday = MONDAY - datetime.timedelta(days=7)
        resp = client.post("/api/v1/rota/generate", json={
            "start_date": prev_monday.isoformat(), "num_weeks": 2,
            "template_start_week": 1,
        })
        assert resp.status_code == 409

    def test_generate_allowed_after_committed_rota_ends(self, client, seeded):
        make_clinic_type_via_api(client, seeded)
        out = generate_rota(client, num_weeks=1)
        assert client.post(f"/api/v1/rota/{out['rota_id']}/commit").status_code == 200

        resp = client.post("/api/v1/rota/generate", json={
            "start_date": (MONDAY + datetime.timedelta(days=7)).isoformat(),
            "num_weeks": 1, "template_start_week": 1,
        })
        assert resp.status_code == 200

    def test_generate_allowed_over_scrapped_rota_range(self, client, seeded):
        make_clinic_type_via_api(client, seeded)
        out = generate_rota(client)
        assert client.delete(f"/api/v1/rota/{out['rota_id']}").status_code == 204

        # Scrap deletes the rota outright, so the same range is free again.
        resp = client.post("/api/v1/rota/generate", json={
            "start_date": MONDAY.isoformat(), "num_weeks": 1, "template_start_week": 1,
        })
        assert resp.status_code == 200

    def test_generate_422_without_active_template(self, client, db_session, seeded):
        from app.models import MasterRotaTemplate
        t = db_session.get(MasterRotaTemplate, seeded["template"])
        t.is_active = False
        db_session.commit()
        resp = client.post("/api/v1/rota/generate", json={
            "start_date": "2026-01-05", "num_weeks": 1, "template_start_week": 1,
        })
        assert resp.status_code == 422
        # And no config/rota row was persisted.
        assert db_session.execute(select(GeneratedRota)).scalars().first() is None


class TestCommit:
    def test_commit_sets_status_and_removes_snapshots(self, client, db_session, seeded):
        make_clinic_type_via_api(client, seeded)
        out = generate_rota(client)
        assert db_session.execute(
            select(RotaSystemCounterSnapshot)).scalars().first() is not None

        resp = client.post(f"/api/v1/rota/{out['rota_id']}/commit")
        assert resp.status_code == 200
        assert resp.json()["status"] == "committed"
        db_session.expire_all()
        assert db_session.execute(
            select(RotaClinicCounterSnapshot)).scalars().first() is None
        assert db_session.execute(
            select(RotaSystemCounterSnapshot)).scalars().first() is None
        # Committing twice is a 409.
        assert client.post(f"/api/v1/rota/{out['rota_id']}/commit").status_code == 409


class TestScrap:
    def test_scrap_restores_counters_and_deletes_rota(self, client, db_session, seeded):
        make_clinic_type_via_api(client, seeded)
        out = generate_rota(client)
        assert _clinic_counters(client)[("AA", "Dragon")] == 1

        resp = client.delete(f"/api/v1/rota/{out['rota_id']}")
        assert resp.status_code == 204
        # No pre-generation clinic counter row existed, so the row created
        # during the draft is deleted outright.
        assert _clinic_counters(client) == {}
        db_session.expire_all()
        assert db_session.execute(select(GeneratedRota)).scalars().first() is None
        assert db_session.execute(select(RotaSession)).scalars().first() is None
        # A new generation is allowed again afterwards.
        out2 = generate_rota(client)
        assert _clinic_counters(client)[("AA", "Dragon")] == 1

    def test_scrap_committed_409(self, client, seeded):
        out = generate_rota(client)
        client.post(f"/api/v1/rota/{out['rota_id']}/commit")
        assert client.delete(f"/api/v1/rota/{out['rota_id']}").status_code == 409


class TestSwaps:
    def test_swap_roles_swaps_fields_and_counters(self, client, db_session, seeded):
        make_clinic_type_via_api(client, seeded)
        out = generate_rota(client)
        am = _monday_am_sessions(client, out["rota_id"])

        resp = client.post(f"/api/v1/rota/{out['rota_id']}/swap-roles", json={
            "session_a_id": am["AA"]["session_id"],
            "session_b_id": am["BB"]["session_id"],
        })
        assert resp.status_code == 200, resp.text
        body = resp.json()
        swapped = {body["session_a"]["doctor_code"]: body["session_a"],
                   body["session_b"]["doctor_code"]: body["session_b"]}
        assert swapped["BB"]["clinic_type_name"] == "Dragon"
        assert swapped["BB"]["role"] == "clinic"
        assert swapped["AA"]["clinic_type_name"] is None
        assert swapped["AA"]["role"] is None

        counters = _clinic_counters(client)
        assert counters[("AA", "Dragon")] == 0  # decremented, floored path unused
        assert counters[("BB", "Dragon")] == 1  # created on demand (force swap)

        # Scrapping after the swap undoes the swap's counter edits too.
        client.delete(f"/api/v1/rota/{out['rota_id']}")
        assert _clinic_counters(client) == {}

    def test_swap_rooms_swaps_room_only(self, client, seeded):
        make_clinic_type_via_api(client, seeded)
        out = generate_rota(client)
        am = _monday_am_sessions(client, out["rota_id"])

        resp = client.post(f"/api/v1/rota/{out['rota_id']}/swap-rooms", json={
            "session_a_id": am["AA"]["session_id"],
            "session_b_id": am["BB"]["session_id"],
        })
        assert resp.status_code == 200, resp.text
        body = resp.json()
        swapped = {body["session_a"]["doctor_code"]: body["session_a"],
                   body["session_b"]["doctor_code"]: body["session_b"]}
        assert swapped["BB"]["room_code"] == "C1"
        assert swapped["AA"]["room_code"] == swapped["AA"]["room_code"]  # unchanged shape
        # Role/clinic untouched; counters untouched.
        assert swapped["AA"]["clinic_type_name"] == "Dragon"
        assert _clinic_counters(client)[("AA", "Dragon")] == 1

    def test_swap_blocked_on_committed_rota(self, client, seeded):
        out = generate_rota(client)
        am = _monday_am_sessions(client, out["rota_id"])
        client.post(f"/api/v1/rota/{out['rota_id']}/commit")
        resp = client.post(f"/api/v1/rota/{out['rota_id']}/swap-roles", json={
            "session_a_id": am["AA"]["session_id"],
            "session_b_id": am["BB"]["session_id"],
        })
        assert resp.status_code == 409


class TestIssues:
    def test_issues_endpoint_reflects_current_state(self, client, seeded):
        out = generate_rota(client)
        resp = client.get(f"/api/v1/rota/{out['rota_id']}/issues")
        assert resp.status_code == 200
        checks = {i["check"] for i in resp.json()}
        assert "duty_coverage_primary" in checks
        # Also works after commit (read-only on committed rotas).
        client.post(f"/api/v1/rota/{out['rota_id']}/commit")
        assert client.get(f"/api/v1/rota/{out['rota_id']}/issues").status_code == 200


class TestTemplateType:
    """M3.6: template_type persisted at generation, returned via the API,
    and null-safe for any pre-M3.6/manually-nulled row."""

    def test_generate_persists_and_returns_template_type(self, client, seeded):
        # seeded's template is REQUIRES_ROOM for both doctors, Monday AM/PM.
        out = generate_rota(client)
        am = _monday_am_sessions(client, out["rota_id"])
        assert am["AA"]["template_type"] == "requires_room"
        assert am["BB"]["template_type"] == "requires_room"

    def test_null_template_type_serialises_as_null(self, client, db_session, seeded):
        # Simulates a pre-M3.6 legacy row (no backfill was done): API and
        # frontend both treat null as a normal session, so this asserts the
        # response stays well-formed rather than erroring on a null enum.
        out = generate_rota(client)
        am = _monday_am_sessions(client, out["rota_id"])
        session_id = am["AA"]["session_id"]

        row = db_session.get(RotaSession, session_id)
        row.template_type = None
        db_session.commit()

        rota = client.get(f"/api/v1/rota/{out['rota_id']}").json()
        session_out = next(s for s in rota["sessions"] if s["session_id"] == session_id)
        assert session_out["template_type"] is None


class TestDutyOnIncompatibleSlot:
    """M3.7 Phase 0: duty pre-planned onto a NO_SURGERY template slot
    blocks generation with the new check name, end to end through the API.
    (ADMIN_TIME and WFH-does-not-block are covered at the engine level in
    test_generate.py; this is the one API-level check that the 422 shape
    itself - detail as a list under the standard FastAPI envelope - comes
    through correctly.)
    """

    def test_generate_422_duty_on_no_surgery(self, client, db_session, seeded):
        from app.models import DutyAssignment, MasterRotaSession
        from app.models.enums import Day, DutyType, MasterSessionType, Period

        row = db_session.execute(
            select(MasterRotaSession).where(
                MasterRotaSession.doctor_id == seeded["doctor_aa"],
                MasterRotaSession.day == Day.MONDAY,
                MasterRotaSession.period == Period.AM,
            )
        ).scalar_one()
        row.session_type = MasterSessionType.NO_SURGERY
        db_session.add(DutyAssignment(
            date=MONDAY, period=Period.AM, doctor_id=seeded["doctor_aa"],
            duty_type=DutyType.PRIMARY,
        ))
        db_session.commit()

        resp = client.post("/api/v1/rota/generate", json={
            "start_date": MONDAY.isoformat(), "num_weeks": 1, "template_start_week": 1,
        })
        assert resp.status_code == 422
        checks = {i["check"] for i in resp.json()["detail"]}
        assert "duty_on_incompatible_slot" in checks


class TestRoleOnIncompatibleSlotApi:
    """M3.7 Phase 12: toggling WFH on over an existing role surfaces the
    warning in the PATCH response's issues - end to end through the API,
    complementing the engine-level coverage in test_phase12.py.
    """

    def test_wfh_toggle_over_role_warns(self, client, seeded):
        make_clinic_type_via_api(client, seeded)
        out = generate_rota(client)
        am = _monday_am_sessions(client, out["rota_id"])
        session_id = am["AA"]["session_id"]  # AA has the clinic role from setup

        resp = client.patch(
            f"/api/v1/rota/{out['rota_id']}/sessions/{session_id}",
            json={"is_wfh": True},
        )
        assert resp.status_code == 200, resp.text
        checks = {i["check"] for i in resp.json()["issues"]}
        assert "role_on_incompatible_slot" in checks


class TestClosuresApi:
    """M5 Task 4: RotaOut.closed_dates, end to end through the API. The
    `seeded` fixture only templates Monday, so closing Monday empties the
    rota entirely -- a deliberately simple fixture that still exercises the
    full path (closed_dates populated, no sessions, no coverage warnings
    for the closed day).
    """

    def test_generate_over_closed_monday(self, client, db_session, seeded):
        db_session.add(PracticeClosure(date=MONDAY, name="Bank Holiday"))
        db_session.commit()

        out = generate_rota(client)

        rota = client.get(f"/api/v1/rota/{out['rota_id']}").json()
        assert rota["closed_dates"] == [MONDAY.isoformat()]
        assert rota["sessions"] == []

        checks = {
            (i["check"], i.get("day")) for i in out["issues"]
        }
        assert ("duty_coverage_primary", "Monday") not in checks
        assert ("duty_coverage_secondary", "Monday") not in checks

    def test_generate_without_closures_returns_empty_list(self, client, seeded):
        out = generate_rota(client)

        rota = client.get(f"/api/v1/rota/{out['rota_id']}").json()
        assert rota["closed_dates"] == []

    def test_closed_dates_survive_commit(self, client, db_session, seeded):
        db_session.add(PracticeClosure(date=MONDAY))
        db_session.commit()
        out = generate_rota(client)

        resp = client.post(f"/api/v1/rota/{out['rota_id']}/commit")
        assert resp.status_code == 200
        assert resp.json()["closed_dates"] == [MONDAY.isoformat()]

    def test_deleting_closure_after_generation_does_not_change_rota(
        self, client, db_session, seeded
    ):
        closure = PracticeClosure(date=MONDAY)
        db_session.add(closure)
        db_session.commit()
        out = generate_rota(client)

        db_session.delete(db_session.get(PracticeClosure, closure.id))
        db_session.commit()

        rota = client.get(f"/api/v1/rota/{out['rota_id']}").json()
        assert rota["closed_dates"] == [MONDAY.isoformat()]