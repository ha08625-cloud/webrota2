"""Null-side swap moves (M3.5 Tasks 3-4).

The M3 swap endpoints already tolerated one empty side; these tests pin
the move semantics explicitly plus the new both-empty 422 guards:
- role move to an empty target transfers role/clinic and adjusts both
  clinic counters (source decremented, target incremented/created)
- scrap after a move restores counters end to end via the API
- room move to a roomless target transfers the room and deliberately
  raises unresolved_room on the source (the signal to reassign)
- both-empty role and room swaps are 422
"""
from sqlalchemy import select

from app.models import ClinicCounter

from .conftest import generate_rota, make_clinic_type_via_api


def _sessions_by_doctor(client, rota_id, period="AM"):
    resp = client.get(f"/api/v1/rota/{rota_id}")
    assert resp.status_code == 200, resp.text
    return {
        s["doctor_code"]: s
        for s in resp.json()["sessions"]
        if s["period"] == period
    }


def _clinic_counts(db_session, clinic_type_id):
    db_session.expire_all()
    rows = db_session.execute(
        select(ClinicCounter).where(ClinicCounter.clinic_type_id == clinic_type_id)
    ).scalars().all()
    return {r.doctor_id: r.raw_count for r in rows}


def test_role_move_to_empty_transfers_and_adjusts_counters(
    client, seeded, db_session
):
    ct = make_clinic_type_via_api(client, seeded)
    gen = generate_rota(client)
    am = _sessions_by_doctor(client, gen["rota_id"])
    assert am["AA"]["role"] == "clinic"  # generation assigned the clinic to AA
    assert am["BB"]["role"] is None
    assert _clinic_counts(db_session, ct["id"]) == {seeded["doctor_aa"]: 1}

    resp = client.post(f"/api/v1/rota/{gen['rota_id']}/swap-roles", json={
        "session_a_id": am["AA"]["session_id"],
        "session_b_id": am["BB"]["session_id"],
    })
    assert resp.status_code == 200, resp.text
    body = resp.json()
    moved = {body["session_a"]["doctor_code"]: body["session_a"],
             body["session_b"]["doctor_code"]: body["session_b"]}
    assert moved["BB"]["role"] == "clinic"
    assert moved["BB"]["clinic_type_id"] == ct["id"]
    assert moved["AA"]["role"] is None
    assert moved["AA"]["clinic_type_id"] is None
    # Source decremented to 0 (row kept), target row created at 1.
    assert _clinic_counts(db_session, ct["id"]) == {
        seeded["doctor_aa"]: 0, seeded["doctor_bb"]: 1,
    }


def test_scrap_after_move_restores_counters(client, seeded, db_session):
    ct = make_clinic_type_via_api(client, seeded)
    gen = generate_rota(client)
    am = _sessions_by_doctor(client, gen["rota_id"])
    resp = client.post(f"/api/v1/rota/{gen['rota_id']}/swap-roles", json={
        "session_a_id": am["AA"]["session_id"],
        "session_b_id": am["BB"]["session_id"],
    })
    assert resp.status_code == 200, resp.text

    assert client.delete(f"/api/v1/rota/{gen['rota_id']}").status_code == 204
    # No counter rows existed pre-generation: both draft-period rows gone.
    assert _clinic_counts(db_session, ct["id"]) == {}


def test_role_move_both_empty_422(client, seeded):
    gen = generate_rota(client)
    pm = _sessions_by_doctor(client, gen["rota_id"], period="PM")
    resp = client.post(f"/api/v1/rota/{gen['rota_id']}/swap-roles", json={
        "session_a_id": pm["AA"]["session_id"],
        "session_b_id": pm["BB"]["session_id"],
    })
    assert resp.status_code == 422


def test_room_move_to_empty_transfers_and_warns_on_source(
    client, seeded, db_session
):
    ct = make_clinic_type_via_api(client, seeded)
    gen = generate_rota(client)
    am = _sessions_by_doctor(client, gen["rota_id"])
    assert am["AA"]["room_code"] == "C1"  # assigned with the clinic
    assert am["BB"]["room_code"] is None

    resp = client.post(f"/api/v1/rota/{gen['rota_id']}/swap-rooms", json={
        "session_a_id": am["AA"]["session_id"],
        "session_b_id": am["BB"]["session_id"],
    })
    assert resp.status_code == 200, resp.text
    body = resp.json()
    moved = {body["session_a"]["doctor_code"]: body["session_a"],
             body["session_b"]["doctor_code"]: body["session_b"]}
    assert moved["BB"]["room_code"] == "C1"
    assert moved["AA"]["room_code"] is None
    # Deliberate consequence: AA now warns unresolved_room for this slot.
    warnings = [
        i for i in body["issues"]
        if i["check"] == "unresolved_room"
        and i["period"] == "AM" and "AA" in i["message"]
    ]
    assert len(warnings) == 1
    # No counter effect from a room move.
    assert _clinic_counts(db_session, ct["id"]) == {seeded["doctor_aa"]: 1}


def test_room_move_both_empty_422(client, seeded):
    gen = generate_rota(client)
    pm = _sessions_by_doctor(client, gen["rota_id"], period="PM")
    resp = client.post(f"/api/v1/rota/{gen['rota_id']}/swap-rooms", json={
        "session_a_id": pm["AA"]["session_id"],
        "session_b_id": pm["BB"]["session_id"],
    })
    assert resp.status_code == 422