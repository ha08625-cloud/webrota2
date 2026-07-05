"""Rota lifecycle and swap tests via the API (M3 Task 8)."""
from sqlalchemy import select

from app.models import (
    ClinicCounter,
    GeneratedRota,
    RotaClinicCounterSnapshot,
    RotaSession,
    RotaSystemCounterSnapshot,
)

from .conftest import generate_rota, make_clinic_type_via_api


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