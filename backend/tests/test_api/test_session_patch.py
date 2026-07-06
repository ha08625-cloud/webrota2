"""PATCH /rota/{id}/sessions/{sid} (M3.5 Task 2).

Covers: WFH on clears the room and silences unresolved_room for that slot
(new Phase 12 skip); WFH off leaves the room null and re-surfaces the
warning; notes set and null-clear; empty patch 422; committed 409;
cross-rota session 404. Rooms are set directly via db_session where a
deterministic starting room is needed (generation-time room assignment is
not the subject under test).
"""
from app.models import RotaSession

from .conftest import generate_rota


def _sessions(client, rota_id):
    resp = client.get(f"/api/v1/rota/{rota_id}")
    assert resp.status_code == 200, resp.text
    return resp.json()["sessions"]


def _unresolved_for(issues, target):
    return [
        i for i in issues
        if i["check"] == "unresolved_room"
        and i["week"] == target["week"]
        and i["day"] == target["day"]
        and i["period"] == target["period"]
        and target["doctor_code"] in i["message"]
    ]

def _set_room(db_session, session_id, room_id):
    s = db_session.get(RotaSession, session_id)
    s.room_id = room_id
    db_session.commit()


def test_wfh_on_clears_room_and_silences_warning(client, seeded, db_session):
    gen = generate_rota(client)
    target = _sessions(client, gen["rota_id"])[0]
    _set_room(db_session, target["session_id"], seeded["room_c1"])

    resp = client.patch(
        f"/api/v1/rota/{gen['rota_id']}/sessions/{target['session_id']}",
        json={"is_wfh": True},
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["session"]["is_wfh"] is True
    assert body["session"]["room_id"] is None
    assert body["session"]["room_code"] is None
    # REQUIRES_ROOM slot with no room, but WFH: must not warn.
    assert _unresolved_for(body["issues"], target) == []


def test_wfh_off_leaves_room_null_and_warns(client, seeded, db_session):
    gen = generate_rota(client)
    target = _sessions(client, gen["rota_id"])[0]
    _set_room(db_session, target["session_id"], seeded["room_c1"])
    url = f"/api/v1/rota/{gen['rota_id']}/sessions/{target['session_id']}"

    assert client.patch(url, json={"is_wfh": True}).status_code == 200
    resp = client.patch(url, json={"is_wfh": False})
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["session"]["is_wfh"] is False
    assert body["session"]["room_id"] is None  # no room restored
    warnings = _unresolved_for(body["issues"], target)
    assert len(warnings) == 1
    assert target["doctor_code"] in warnings[0]["message"]


def test_notes_set_and_clear(client, seeded):
    gen = generate_rota(client)
    target = _sessions(client, gen["rota_id"])[0]
    url = f"/api/v1/rota/{gen['rota_id']}/sessions/{target['session_id']}"

    resp = client.patch(url, json={"notes": "cover for BB"})
    assert resp.status_code == 200
    assert resp.json()["session"]["notes"] == "cover for BB"

    # Absent notes field leaves notes alone.
    resp = client.patch(url, json={"is_wfh": False})
    assert resp.json()["session"]["notes"] == "cover for BB"

    # Explicit null clears.
    resp = client.patch(url, json={"notes": None})
    assert resp.status_code == 200
    assert resp.json()["session"]["notes"] is None


def test_empty_patch_422(client, seeded):
    gen = generate_rota(client)
    target = _sessions(client, gen["rota_id"])[0]
    resp = client.patch(
        f"/api/v1/rota/{gen['rota_id']}/sessions/{target['session_id']}", json={}
    )
    assert resp.status_code == 422


def test_committed_rota_409(client, seeded):
    gen = generate_rota(client)
    target = _sessions(client, gen["rota_id"])[0]
    assert client.post(f"/api/v1/rota/{gen['rota_id']}/commit").status_code == 200
    resp = client.patch(
        f"/api/v1/rota/{gen['rota_id']}/sessions/{target['session_id']}",
        json={"is_wfh": True},
    )
    assert resp.status_code == 409


def test_unknown_or_cross_rota_session_404(client, seeded):
    gen = generate_rota(client)
    resp = client.patch(
        f"/api/v1/rota/{gen['rota_id']}/sessions/999999", json={"is_wfh": True}
    )
    assert resp.status_code == 404