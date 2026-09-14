"""WFH system counter adjustments on draft edits.

The WFH counter is the one system counter written outside generation: a
manual is_wfh toggle in a draft moves it, because is_wfh is hand-edited far
more often than is_supervising and a generation-only count would disagree
with the committed rota. These tests pin the three rules that keeps honest:
adjust on a real transition only (not on the field merely being present in
the patch), decrement when set-room clears is_wfh as a side effect, and skip
sessions on booked leave, which the engine's own tally never counted.

The `seeded` fixture's template is REQUIRES_ROOM only, so every WFH counter
starts generation at whatever it was seeded with and generation adds nothing
-- the deltas asserted here are purely the API's.
"""
import datetime

from sqlalchemy import select

from app.models import LeaveEntry, RotaSession, SystemCounter
from app.models.enums import SystemCounterType

from .conftest import MONDAY, generate_rota


def _wfh_count(db_session, doctor_id: int) -> int:
    db_session.expire_all()
    return db_session.execute(
        select(SystemCounter).where(
            SystemCounter.doctor_id == doctor_id,
            SystemCounter.counter_type == SystemCounterType.WFH,
        )
    ).scalar_one().raw_count


def _set_wfh_count(db_session, doctor_id: int, value: int) -> None:
    row = db_session.execute(
        select(SystemCounter).where(
            SystemCounter.doctor_id == doctor_id,
            SystemCounter.counter_type == SystemCounterType.WFH,
        )
    ).scalar_one()
    row.raw_count = value
    db_session.commit()


def _sessions(client, rota_id):
    resp = client.get(f"/api/v1/rota/{rota_id}")
    assert resp.status_code == 200, resp.text
    return resp.json()["sessions"]


def _session_date(target) -> datetime.date:
    """The `seeded` template is Monday-only in week 1, so every generated
    session falls on the run's start date."""
    assert target["week"] == 1 and target["day"] == "Monday"
    return MONDAY


class TestPatchSessionWfhCounter:
    def test_toggle_on_then_off_round_trips(self, client, seeded, db_session):
        gen = generate_rota(client)
        target = _sessions(client, gen["rota_id"])[0]
        before = _wfh_count(db_session, target["doctor_id"])
        url = f"/api/v1/rota/{gen['rota_id']}/sessions/{target['session_id']}"

        assert client.patch(url, json={"is_wfh": True}).status_code == 200
        assert _wfh_count(db_session, target["doctor_id"]) == before + 1

        assert client.patch(url, json={"is_wfh": False}).status_code == 200
        assert _wfh_count(db_session, target["doctor_id"]) == before

    def test_redundant_patch_does_not_double_count(self, client, seeded, db_session):
        """The undo stack replays a patch with the entry's previous is_wfh
        alongside the field it is actually undoing, so a no-op is_wfh must
        not move the counter."""
        gen = generate_rota(client)
        target = _sessions(client, gen["rota_id"])[0]
        before = _wfh_count(db_session, target["doctor_id"])
        url = f"/api/v1/rota/{gen['rota_id']}/sessions/{target['session_id']}"

        assert client.patch(url, json={"is_wfh": True}).status_code == 200
        assert client.patch(url, json={"is_wfh": True}).status_code == 200
        assert client.patch(url, json={"is_wfh": True, "notes": "x"}).status_code == 200
        assert _wfh_count(db_session, target["doctor_id"]) == before + 1

        # ...and the same on the way back down.
        assert client.patch(url, json={"is_wfh": False}).status_code == 200
        assert client.patch(url, json={"is_wfh": False}).status_code == 200
        assert _wfh_count(db_session, target["doctor_id"]) == before

    def test_notes_only_patch_does_not_move_counter(self, client, seeded, db_session):
        gen = generate_rota(client)
        target = _sessions(client, gen["rota_id"])[0]
        before = _wfh_count(db_session, target["doctor_id"])
        url = f"/api/v1/rota/{gen['rota_id']}/sessions/{target['session_id']}"

        assert client.patch(url, json={"notes": "cover"}).status_code == 200
        assert client.patch(url, json={"is_supervising": True}).status_code == 200
        assert _wfh_count(db_session, target["doctor_id"]) == before

    def test_toggle_on_leave_session_does_not_count(self, client, seeded, db_session):
        """D9: leave dominates WFH. The doctor did not work the session from
        home, so neither direction of the toggle touches the counter."""
        gen = generate_rota(client)
        target = _sessions(client, gen["rota_id"])[0]
        db_session.add(LeaveEntry(
            doctor_id=target["doctor_id"],
            date=_session_date(target),
            period=target["period"],
        ))
        db_session.commit()
        before = _wfh_count(db_session, target["doctor_id"])
        url = f"/api/v1/rota/{gen['rota_id']}/sessions/{target['session_id']}"

        resp = client.patch(url, json={"is_wfh": True})
        assert resp.status_code == 200, resp.text
        # Guards against the test passing for the wrong reason: the leave row
        # must actually land on this session.
        assert resp.json()["session"]["is_on_leave"] is True
        assert _wfh_count(db_session, target["doctor_id"]) == before
        assert client.patch(url, json={"is_wfh": False}).status_code == 200
        assert _wfh_count(db_session, target["doctor_id"]) == before

    def test_other_doctors_counter_is_untouched(self, client, seeded, db_session):
        gen = generate_rota(client)
        target = _sessions(client, gen["rota_id"])[0]
        other = seeded["doctor_bb"] if target["doctor_id"] == seeded["doctor_aa"] \
            else seeded["doctor_aa"]
        before_other = _wfh_count(db_session, other)
        url = f"/api/v1/rota/{gen['rota_id']}/sessions/{target['session_id']}"

        assert client.patch(url, json={"is_wfh": True}).status_code == 200
        assert _wfh_count(db_session, other) == before_other


class TestSetRoomWfhCounter:
    def test_assigning_a_room_to_a_wfh_slot_decrements(
        self, client, seeded, db_session
    ):
        gen = generate_rota(client)
        target = _sessions(client, gen["rota_id"])[0]
        base = _wfh_count(db_session, target["doctor_id"])
        sid = target["session_id"]

        assert client.patch(
            f"/api/v1/rota/{gen['rota_id']}/sessions/{sid}", json={"is_wfh": True}
        ).status_code == 200
        assert _wfh_count(db_session, target["doctor_id"]) == base + 1

        resp = client.post(
            f"/api/v1/rota/{gen['rota_id']}/sessions/{sid}/set-room",
            json={"room_id": seeded["room_c1"]},
        )
        assert resp.status_code == 200, resp.text
        assert resp.json()["session"]["is_wfh"] is False
        assert _wfh_count(db_session, target["doctor_id"]) == base

    def test_set_room_on_non_wfh_slot_does_not_move_counter(
        self, client, seeded, db_session
    ):
        gen = generate_rota(client)
        target = _sessions(client, gen["rota_id"])[0]
        before = _wfh_count(db_session, target["doctor_id"])
        sid = target["session_id"]

        assert client.post(
            f"/api/v1/rota/{gen['rota_id']}/sessions/{sid}/set-room",
            json={"room_id": seeded["room_c1"]},
        ).status_code == 200
        assert client.post(
            f"/api/v1/rota/{gen['rota_id']}/sessions/{sid}/set-room",
            json={"room_id": None},
        ).status_code == 200
        assert _wfh_count(db_session, target["doctor_id"]) == before

    def test_set_room_on_leave_wfh_slot_does_not_decrement(
        self, client, seeded, db_session
    ):
        """The WFH was never counted (D9), so clearing it must not decrement
        -- otherwise the counter goes negative."""
        gen = generate_rota(client)
        target = _sessions(client, gen["rota_id"])[0]
        db_session.add(LeaveEntry(
            doctor_id=target["doctor_id"],
            date=_session_date(target),
            period=target["period"],
        ))
        db_session.commit()
        before = _wfh_count(db_session, target["doctor_id"])
        sid = target["session_id"]

        patched = client.patch(
            f"/api/v1/rota/{gen['rota_id']}/sessions/{sid}", json={"is_wfh": True}
        )
        assert patched.status_code == 200, patched.text
        assert patched.json()["session"]["is_on_leave"] is True
        assert client.post(
            f"/api/v1/rota/{gen['rota_id']}/sessions/{sid}/set-room",
            json={"room_id": seeded["room_c1"]},
        ).status_code == 200
        assert _wfh_count(db_session, target["doctor_id"]) == before


class TestScrapRestoresManualWfhEdits:
    def test_scrap_undoes_manual_toggles(self, client, seeded, db_session):
        """The draft snapshot captures raw counts before generation, so
        scrapping unwinds mid-draft WFH edits along with the engine's own
        tally -- the same contract swap-roles' clinic counters rely on."""
        _set_wfh_count(db_session, seeded["doctor_aa"], 4)
        _set_wfh_count(db_session, seeded["doctor_bb"], 7)

        gen = generate_rota(client)
        for target in _sessions(client, gen["rota_id"]):
            assert client.patch(
                f"/api/v1/rota/{gen['rota_id']}/sessions/{target['session_id']}",
                json={"is_wfh": True},
            ).status_code == 200
        assert _wfh_count(db_session, seeded["doctor_aa"]) == 6
        assert _wfh_count(db_session, seeded["doctor_bb"]) == 9

        assert client.delete(f"/api/v1/rota/{gen['rota_id']}").status_code == 204
        assert _wfh_count(db_session, seeded["doctor_aa"]) == 4
        assert _wfh_count(db_session, seeded["doctor_bb"]) == 7
        db_session.expire_all()
        assert db_session.execute(select(RotaSession)).scalars().first() is None
