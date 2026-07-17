"""POST /rota/{id}/sessions/{sid}/set-room and set-role (M4.1 Task 1).

set-room: direct assign, steal-displaces-holder, clear via null, assign
onto WFH clears is_wfh, assign-already-held-room is a no-op, 404s, 409.

set-role: duty steal, clinic-type steal with counter assertions, normal
clinic (no displacement), no_surgery pick (room cleared, floor-at-0
exercised), unassign (template preserved), same-clinic-type reassign is a
counter no-op, verbatim restoration of a warned triple composes with
M3.7's role_on_incompatible_slot, 422 on clinic_type_id without
role='clinic', 404s, 409.
"""
from sqlalchemy import select

from app.models import ClinicCounter, RotaSession
from app.models.enums import SessionRole

from .conftest import generate_rota, make_clinic_type_via_api


def _sessions_by_doctor(client, rota_id, period="AM"):
    resp = client.get(f"/api/v1/rota/{rota_id}")
    assert resp.status_code == 200, resp.text
    return {
        s["doctor_code"]: s
        for s in resp.json()["sessions"]
        if s["period"] == period
    }


def _clinic_count(db_session, doctor_id, clinic_type_id):
    db_session.expire_all()
    row = db_session.execute(
        select(ClinicCounter).where(
            ClinicCounter.doctor_id == doctor_id,
            ClinicCounter.clinic_type_id == clinic_type_id,
        )
    ).scalar_one_or_none()
    return row.raw_count if row is not None else 0


def _set_role_direct(db_session, session_id, role, clinic_type_id=None):
    s = db_session.get(RotaSession, session_id)
    s.role = role
    s.clinic_type_id = clinic_type_id
    db_session.commit()


def _set_room_direct(db_session, session_id, room_id):
    s = db_session.get(RotaSession, session_id)
    s.room_id = room_id
    db_session.commit()


def _set_counter(db_session, doctor_id, clinic_type_id, raw_count):
    row = db_session.execute(
        select(ClinicCounter).where(
            ClinicCounter.doctor_id == doctor_id,
            ClinicCounter.clinic_type_id == clinic_type_id,
        )
    ).scalar_one_or_none()
    assert row is not None
    row.raw_count = raw_count
    db_session.commit()


# ---------------------------------------------------------------------------
# set-room
# ---------------------------------------------------------------------------

def test_set_room_direct_assign_to_free_room(client, seeded_no_d_rooms):
    gen = generate_rota(client)
    am = _sessions_by_doctor(client, gen["rota_id"])
    assert am["TT"]["room_code"] is None

    resp = client.post(
        f"/api/v1/rota/{gen['rota_id']}/sessions/{am['TT']['session_id']}/set-room",
        json={"room_id": seeded_no_d_rooms["room_c2"]},
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["session"]["room_code"] == "C2"
    assert body["displaced_session"] is None


def test_set_room_steal_displaces_holder(client, seeded_no_d_rooms):
    gen = generate_rota(client)
    am = _sessions_by_doctor(client, gen["rota_id"])
    assert am["AA"]["room_code"] == "C1"
    assert am["TT"]["room_code"] is None

    resp = client.post(
        f"/api/v1/rota/{gen['rota_id']}/sessions/{am['TT']['session_id']}/set-room",
        json={"room_id": seeded_no_d_rooms["room_c1"]},
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["session"]["doctor_code"] == "TT"
    assert body["session"]["room_code"] == "C1"
    assert body["displaced_session"]["doctor_code"] == "AA"
    assert body["displaced_session"]["room_code"] is None


def test_set_room_clear_via_null(client, seeded):
    ct = make_clinic_type_via_api(client, seeded)
    gen = generate_rota(client)
    am = _sessions_by_doctor(client, gen["rota_id"])

    resp = client.post(
        f"/api/v1/rota/{gen['rota_id']}/sessions/{am['AA']['session_id']}/set-room",
        json={"room_id": None},
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["session"]["room_code"] is None
    assert body["displaced_session"] is None


def test_set_room_onto_wfh_clears_is_wfh(client, seeded):
    gen = generate_rota(client)
    am = _sessions_by_doctor(client, gen["rota_id"])
    url = f"/api/v1/rota/{gen['rota_id']}/sessions/{am['BB']['session_id']}"
    assert client.patch(url, json={"is_wfh": True}).status_code == 200

    resp = client.post(f"{url}/set-room", json={"room_id": seeded["room_d1"]})
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["session"]["is_wfh"] is False
    assert body["session"]["room_code"] == "D1"


def test_set_room_already_held_is_noop(client, seeded):
    ct = make_clinic_type_via_api(client, seeded)
    gen = generate_rota(client)
    am = _sessions_by_doctor(client, gen["rota_id"])

    resp = client.post(
        f"/api/v1/rota/{gen['rota_id']}/sessions/{am['AA']['session_id']}/set-room",
        json={"room_id": seeded["room_c1"]},
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["session"]["room_code"] == "C1"
    assert body["displaced_session"] is None


def test_set_room_unknown_room_404(client, seeded):
    gen = generate_rota(client)
    am = _sessions_by_doctor(client, gen["rota_id"])
    resp = client.post(
        f"/api/v1/rota/{gen['rota_id']}/sessions/{am['BB']['session_id']}/set-room",
        json={"room_id": 999999},
    )
    assert resp.status_code == 404


def test_set_room_unknown_session_404(client, seeded):
    gen = generate_rota(client)
    resp = client.post(
        f"/api/v1/rota/{gen['rota_id']}/sessions/999999/set-room",
        json={"room_id": seeded["room_d1"]},
    )
    assert resp.status_code == 404


def test_set_room_committed_409(client, seeded):
    gen = generate_rota(client)
    am = _sessions_by_doctor(client, gen["rota_id"])
    assert client.post(f"/api/v1/rota/{gen['rota_id']}/commit").status_code == 200
    resp = client.post(
        f"/api/v1/rota/{gen['rota_id']}/sessions/{am['BB']['session_id']}/set-room",
        json={"room_id": seeded["room_d1"]},
    )
    assert resp.status_code == 409


# ---------------------------------------------------------------------------
# set-role
# ---------------------------------------------------------------------------

def test_set_role_duty_steal(client, seeded, db_session):
    gen = generate_rota(client)
    am = _sessions_by_doctor(client, gen["rota_id"])
    _set_role_direct(db_session, am["AA"]["session_id"], SessionRole.DUTY_PRIMARY)

    resp = client.post(
        f"/api/v1/rota/{gen['rota_id']}/sessions/{am['BB']['session_id']}/set-role",
        json={
            "role": "duty_primary",
            "clinic_type_id": None,
            "template_type": am["BB"]["template_type"],
        },
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["session"]["doctor_code"] == "BB"
    assert body["session"]["role"] == "duty_primary"
    assert body["session"]["template_type"] == am["BB"]["template_type"]
    assert body["displaced_session"]["doctor_code"] == "AA"
    assert body["displaced_session"]["role"] is None
    assert body["displaced_session"]["template_type"] == am["AA"]["template_type"]


def test_set_role_clinic_type_steal_with_counters(client, seeded, db_session):
    ct = make_clinic_type_via_api(client, seeded)
    gen = generate_rota(client)
    am = _sessions_by_doctor(client, gen["rota_id"])
    assert am["AA"]["clinic_type_id"] == ct["id"]
    assert _clinic_count(db_session, seeded["doctor_aa"], ct["id"]) == 1

    resp = client.post(
        f"/api/v1/rota/{gen['rota_id']}/sessions/{am['BB']['session_id']}/set-role",
        json={
            "role": "clinic",
            "clinic_type_id": ct["id"],
            "template_type": am["BB"]["template_type"],
        },
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["session"]["doctor_code"] == "BB"
    assert body["session"]["clinic_type_id"] == ct["id"]
    assert body["displaced_session"]["doctor_code"] == "AA"
    assert body["displaced_session"]["clinic_type_id"] is None
    assert _clinic_count(db_session, seeded["doctor_aa"], ct["id"]) == 0
    assert _clinic_count(db_session, seeded["doctor_bb"], ct["id"]) == 1


def test_set_role_normal_clinic_no_displacement(client, seeded, db_session):
    ct = make_clinic_type_via_api(client, seeded)
    gen = generate_rota(client)
    am = _sessions_by_doctor(client, gen["rota_id"])

    resp = client.post(
        f"/api/v1/rota/{gen['rota_id']}/sessions/{am['AA']['session_id']}/set-role",
        json={
            "role": "clinic",
            "clinic_type_id": None,
            "template_type": am["AA"]["template_type"],
        },
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["session"]["role"] == "clinic"
    assert body["session"]["clinic_type_id"] is None
    assert body["displaced_session"] is None
    assert _clinic_count(db_session, seeded["doctor_aa"], ct["id"]) == 0


def test_set_role_no_surgery_pick_clears_room_and_floors_counter(
    client, seeded, db_session
):
    ct = make_clinic_type_via_api(client, seeded)
    gen = generate_rota(client)
    am = _sessions_by_doctor(client, gen["rota_id"])
    assert am["AA"]["room_code"] == "C1"
    # Force the floor: the counter is already at 0 when the decrement fires.
    _set_counter(db_session, seeded["doctor_aa"], ct["id"], 0)

    resp = client.post(
        f"/api/v1/rota/{gen['rota_id']}/sessions/{am['AA']['session_id']}/set-role",
        json={"role": None, "clinic_type_id": None, "template_type": "no_surgery"},
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["session"]["role"] is None
    assert body["session"]["clinic_type_id"] is None
    assert body["session"]["template_type"] == "no_surgery"
    assert body["session"]["room_code"] is None
    assert _clinic_count(db_session, seeded["doctor_aa"], ct["id"]) == 0


def test_set_role_unassign_preserves_template(client, seeded, db_session):
    ct = make_clinic_type_via_api(client, seeded)
    gen = generate_rota(client)
    am = _sessions_by_doctor(client, gen["rota_id"])
    original_template = am["AA"]["template_type"]

    resp = client.post(
        f"/api/v1/rota/{gen['rota_id']}/sessions/{am['AA']['session_id']}/set-role",
        json={
            "role": None,
            "clinic_type_id": None,
            "template_type": original_template,
        },
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["session"]["role"] is None
    assert body["session"]["clinic_type_id"] is None
    assert body["session"]["template_type"] == original_template
    assert body["session"]["room_code"] == "C1"  # untouched: not a no_surgery/admin_time shape
    assert _clinic_count(db_session, seeded["doctor_aa"], ct["id"]) == 0


def test_set_role_same_clinic_type_reassign_is_counter_noop(
    client, seeded, db_session
):
    ct = make_clinic_type_via_api(client, seeded)
    gen = generate_rota(client)
    am = _sessions_by_doctor(client, gen["rota_id"])
    assert _clinic_count(db_session, seeded["doctor_aa"], ct["id"]) == 1

    resp = client.post(
        f"/api/v1/rota/{gen['rota_id']}/sessions/{am['AA']['session_id']}/set-role",
        json={
            "role": "clinic",
            "clinic_type_id": ct["id"],
            "template_type": am["AA"]["template_type"],
        },
    )
    assert resp.status_code == 200, resp.text
    assert _clinic_count(db_session, seeded["doctor_aa"], ct["id"]) == 1


def test_set_role_verbatim_restore_of_warned_triple_raises_phase12_warning(
    client, seeded
):
    gen = generate_rota(client)
    am = _sessions_by_doctor(client, gen["rota_id"])

    resp = client.post(
        f"/api/v1/rota/{gen['rota_id']}/sessions/{am['AA']['session_id']}/set-role",
        json={
            "role": "duty_primary",
            "clinic_type_id": None,
            "template_type": "no_surgery",
        },
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["session"]["role"] == "duty_primary"
    assert body["session"]["template_type"] == "no_surgery"
    warnings = [
        i for i in body["issues"]
        if i["check"] == "role_on_incompatible_slot"
        and i["period"] == "AM" and "AA" in i["message"]
    ]
    assert len(warnings) == 1


def test_set_role_clinic_type_without_clinic_role_422(client, seeded):
    ct = make_clinic_type_via_api(client, seeded)
    gen = generate_rota(client)
    am = _sessions_by_doctor(client, gen["rota_id"])
    resp = client.post(
        f"/api/v1/rota/{gen['rota_id']}/sessions/{am['AA']['session_id']}/set-role",
        json={
            "role": None,
            "clinic_type_id": ct["id"],
            "template_type": am["AA"]["template_type"],
        },
    )
    assert resp.status_code == 422


def test_set_role_unknown_clinic_type_404(client, seeded):
    gen = generate_rota(client)
    am = _sessions_by_doctor(client, gen["rota_id"])
    resp = client.post(
        f"/api/v1/rota/{gen['rota_id']}/sessions/{am['AA']['session_id']}/set-role",
        json={
            "role": "clinic",
            "clinic_type_id": 999999,
            "template_type": am["AA"]["template_type"],
        },
    )
    assert resp.status_code == 404


def test_set_role_unknown_session_404(client, seeded):
    gen = generate_rota(client)
    resp = client.post(
        f"/api/v1/rota/{gen['rota_id']}/sessions/999999/set-role",
        json={"role": None, "clinic_type_id": None, "template_type": None},
    )
    assert resp.status_code == 404


def test_set_role_committed_409(client, seeded):
    gen = generate_rota(client)
    am = _sessions_by_doctor(client, gen["rota_id"])
    assert client.post(f"/api/v1/rota/{gen['rota_id']}/commit").status_code == 200
    resp = client.post(
        f"/api/v1/rota/{gen['rota_id']}/sessions/{am['AA']['session_id']}/set-role",
        json={
            "role": None,
            "clinic_type_id": None,
            "template_type": am["AA"]["template_type"],
        },
    )
    assert resp.status_code == 409
