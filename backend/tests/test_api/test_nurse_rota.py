"""Nurse rota router tests (Nurse Rota task 2).

The interesting assertions here are not the happy paths -- those are the
master rota's, reused -- but the two rules that make `nurse_rota` a real
permission boundary rather than a filter on the read: a write that names a
non-nurse 404s, and a room held by a non-nurse is a 409 that writes
nothing.
"""
import pytest
from sqlalchemy import select

from app.models import Doctor, MasterRotaSession, MasterRotaTemplate
from app.models.enums import Day, DoctorType, MasterSessionType, Period

NURSE_ROTA = "/api/v1/nurse-rota"


@pytest.fixture
def seeded_nurses(seeded, db_session):
    """Two nurses (N1, N2) on top of `seeded`'s AA/BB and C1/D1/SR/TR1.

    N1 holds TR1 on week 1 Monday AM (pre-assigned); N2 has no sessions, so
    the POST tests have a free (doctor, slot) to create into. AA is given
    D1 in the same slot so the non-nurse occupancy and displacement rules
    have something to refuse.
    """
    s = db_session
    n1 = Doctor(code="N1", doctor_type=DoctorType.NURSE, sessions_per_week=8, active=True)
    n2 = Doctor(code="N2", doctor_type=DoctorType.NURSE, sessions_per_week=8, active=True)
    s.add_all([n1, n2])
    s.flush()
    n1_session = MasterRotaSession(
        template_id=seeded["template"], doctor_id=n1.id, week=1,
        day=Day.MONDAY, period=Period.AM,
        session_type=MasterSessionType.PRE_ASSIGNED, room_id=seeded["room_tr1"],
    )
    s.add(n1_session)
    # AA's week 1 Monday AM row, seeded as REQUIRES_ROOM with no room, is
    # given D1 so it shows up as occupancy and as a displacement refusal.
    aa_row = s.execute(
        select(MasterRotaSession).where(
            MasterRotaSession.template_id == seeded["template"],
            MasterRotaSession.doctor_id == seeded["doctor_aa"],
            MasterRotaSession.period == Period.AM,
        )
    ).scalars().one()
    aa_row.session_type = MasterSessionType.PRE_ASSIGNED
    aa_row.room_id = seeded["room_d1"]
    s.commit()
    return {
        **seeded,
        "nurse_n1": n1.id,
        "nurse_n2": n2.id,
        "n1_session": n1_session.id,
        "aa_session": aa_row.id,
    }


class TestNurseRotaRead:
    def test_no_active_template_404(self, client):
        assert client.get(f"{NURSE_ROTA}/active").status_code == 404

    def test_returns_nurse_rows_only(self, client, seeded_nurses):
        resp = client.get(f"{NURSE_ROTA}/active")
        assert resp.status_code == 200, resp.text
        body = resp.json()
        assert body["template_id"] == seeded_nurses["template"]
        assert body["name"] == "Default"
        assert [s["doctor_code"] for s in body["sessions"]] == ["N1"]
        assert body["sessions"][0]["doctor_type"] == "Nurse"
        assert body["sessions"][0]["room_code"] == "TR1"

    def test_rooms_are_all_rooms_not_just_treatment_rooms(
        self, client, seeded_nurses
    ):
        # A nurse may be placed in any room, so the picker gets the
        # whole list rather than RoomType.TR only.
        codes = {r["code"] for r in client.get(f"{NURSE_ROTA}/active").json()["rooms"]}
        assert codes == {"C1", "D1", "SR", "TR1"}

    def test_occupancy_holds_doctor_rooms_and_no_nurse_rooms(
        self, client, seeded_nurses
    ):
        occupancy = client.get(f"{NURSE_ROTA}/active").json()["occupancy"]
        assert len(occupancy) == 1
        entry = occupancy[0]
        assert entry["doctor_code"] == "AA"
        assert entry["room_code"] == "D1"
        assert entry["room_id"] == seeded_nurses["room_d1"]
        assert (entry["week"], entry["day"], entry["period"]) == (1, "Monday", "AM")
        # N1's TR1 is a nurse row: it is in `sessions`, never in occupancy.
        assert all(e["room_id"] != seeded_nurses["room_tr1"] for e in occupancy)

    def test_roomless_doctor_rows_contribute_nothing(
        self, client, seeded_nurses, db_session
    ):
        # BB's two seeded rows are REQUIRES_ROOM with no room.
        body = client.get(f"{NURSE_ROTA}/active").json()
        assert all(s["doctor_code"] != "BB" for s in body["sessions"])
        assert all(e["doctor_code"] != "BB" for e in body["occupancy"])


class TestNurseSessionPatch:
    def _patch(self, client, session_id, **payload):
        return client.patch(f"{NURSE_ROTA}/sessions/{session_id}", json=payload)

    def test_sets_the_pair(self, client, seeded_nurses, db_session):
        resp = self._patch(
            client, seeded_nurses["n1_session"],
            session_type="admin_time", room_id=None,
        )
        assert resp.status_code == 200, resp.text
        body = resp.json()
        assert body["session"]["session_type"] == "admin_time"
        assert body["session"]["room_id"] is None
        assert body["displaced_session"] is None
        db_session.expire_all()
        row = db_session.get(MasterRotaSession, seeded_nurses["n1_session"])
        assert row.session_type == MasterSessionType.ADMIN_TIME
        assert row.room_id is None

    def test_no_surgery(self, client, seeded_nurses):
        resp = self._patch(
            client, seeded_nurses["n1_session"],
            session_type="no_surgery", room_id=None,
        )
        assert resp.status_code == 200, resp.text
        assert resp.json()["session"]["session_type"] == "no_surgery"

    def test_unknown_session_404(self, client, seeded_nurses):
        assert self._patch(
            client, 99999, session_type="admin_time", room_id=None
        ).status_code == 404

    def test_non_nurse_session_404(self, client, seeded_nurses, db_session):
        # 404 rather than 403 -- the session is not part of this
        # resource, and a 403 would confirm it exists.
        resp = self._patch(
            client, seeded_nurses["aa_session"],
            session_type="admin_time", room_id=None,
        )
        assert resp.status_code == 404
        db_session.expire_all()
        aa = db_session.get(MasterRotaSession, seeded_nurses["aa_session"])
        assert aa.room_id == seeded_nurses["room_d1"]

    def test_session_in_another_template_404(
        self, client, seeded_nurses, db_session
    ):
        # The path carries no template_id, so the router has to
        # verify the session belongs to the ACTIVE template or an archived
        # template's rows would be editable by id.
        other = MasterRotaTemplate(name="Old", is_active=False)
        db_session.add(other)
        db_session.flush()
        stray = MasterRotaSession(
            template_id=other.id, doctor_id=seeded_nurses["nurse_n1"], week=1,
            day=Day.TUESDAY, period=Period.AM,
            session_type=MasterSessionType.ADMIN_TIME,
        )
        db_session.add(stray)
        db_session.commit()

        assert self._patch(
            client, stray.id, session_type="no_surgery", room_id=None
        ).status_code == 404

    @pytest.mark.parametrize("session_type", ["wfh", "requires_room"])
    def test_non_nurse_session_type_422(self, client, seeded_nurses, session_type):
        # Enforced on the Pydantic model so it is a 422 naming the
        # field rather than a hand-rolled 400 in the router.
        assert self._patch(
            client, seeded_nurses["n1_session"],
            session_type=session_type, room_id=None,
        ).status_code == 422

    def test_pre_assigned_without_room_422(self, client, seeded_nurses):
        assert self._patch(
            client, seeded_nurses["n1_session"],
            session_type="pre_assigned", room_id=None,
        ).status_code == 422

    def test_no_surgery_with_room_422(self, client, seeded_nurses):
        assert self._patch(
            client, seeded_nurses["n1_session"],
            session_type="no_surgery", room_id=seeded_nurses["room_c1"],
        ).status_code == 422

    def test_unknown_room_404(self, client, seeded_nurses):
        assert self._patch(
            client, seeded_nurses["n1_session"],
            session_type="pre_assigned", room_id=99999,
        ).status_code == 404

    def test_displaces_a_nurse(self, client, seeded_nurses, db_session):
        # N2 takes TR1 from N1 -- same behaviour as the master rota's:
        # room cleared, and a displaced PRE_ASSIGNED becomes REQUIRES_ROOM.
        created = client.post(f"{NURSE_ROTA}/sessions", json={
            "doctor_id": seeded_nurses["nurse_n2"], "week": 1, "day": "Monday",
            "period": "AM", "session_type": "admin_time", "room_id": None,
        })
        assert created.status_code == 201, created.text
        n2_session = created.json()["session"]["session_id"]

        resp = self._patch(
            client, n2_session,
            session_type="pre_assigned", room_id=seeded_nurses["room_tr1"],
        )
        assert resp.status_code == 200, resp.text
        displaced = resp.json()["displaced_session"]
        assert displaced["session_id"] == seeded_nurses["n1_session"]
        assert displaced["room_id"] is None
        assert displaced["session_type"] == "requires_room"

    def test_taking_a_doctors_room_409s_and_writes_nothing(
        self, client, seeded_nurses, db_session
    ):
        # The permission boundary itself: displacement is the mechanism by
        # which a nurse_rota-only login could otherwise mutate a doctor's
        # row, so it refuses rather than displacing.
        resp = self._patch(
            client, seeded_nurses["n1_session"],
            session_type="pre_assigned", room_id=seeded_nurses["room_d1"],
        )
        assert resp.status_code == 409
        assert "AA" in resp.json()["detail"]

        db_session.expire_all()
        aa = db_session.get(MasterRotaSession, seeded_nurses["aa_session"])
        assert aa.room_id == seeded_nurses["room_d1"]
        assert aa.session_type == MasterSessionType.PRE_ASSIGNED
        n1 = db_session.get(MasterRotaSession, seeded_nurses["n1_session"])
        assert n1.room_id == seeded_nurses["room_tr1"]

    def test_keeping_own_room_is_not_a_displacement(self, client, seeded_nurses):
        resp = self._patch(
            client, seeded_nurses["n1_session"],
            session_type="pre_assigned", room_id=seeded_nurses["room_tr1"],
        )
        assert resp.status_code == 200, resp.text
        assert resp.json()["displaced_session"] is None


class TestNurseSessionCreate:
    def _post(self, client, **payload):
        return client.post(f"{NURSE_ROTA}/sessions", json=payload)

    def test_creates(self, client, seeded_nurses, db_session):
        resp = self._post(
            client, doctor_id=seeded_nurses["nurse_n2"], week=3, day="Wednesday",
            period="PM", session_type="pre_assigned",
            room_id=seeded_nurses["room_c1"],
        )
        assert resp.status_code == 201, resp.text
        body = resp.json()["session"]
        assert body["doctor_code"] == "N2"
        assert body["room_code"] == "C1"
        assert body["week"] == 3
        row = db_session.get(MasterRotaSession, body["session_id"])
        assert row.template_id == seeded_nurses["template"]

    def test_non_nurse_doctor_404(self, client, seeded_nurses):
        assert self._post(
            client, doctor_id=seeded_nurses["doctor_aa"], week=3, day="Wednesday",
            period="PM", session_type="admin_time", room_id=None,
        ).status_code == 404

    def test_unknown_doctor_404(self, client, seeded_nurses):
        assert self._post(
            client, doctor_id=99999, week=3, day="Wednesday", period="PM",
            session_type="admin_time", room_id=None,
        ).status_code == 404

    def test_duplicate_slot_409(self, client, seeded_nurses):
        assert self._post(
            client, doctor_id=seeded_nurses["nurse_n1"], week=1, day="Monday",
            period="AM", session_type="admin_time", room_id=None,
        ).status_code == 409

    def test_wfh_422(self, client, seeded_nurses):
        assert self._post(
            client, doctor_id=seeded_nurses["nurse_n2"], week=2, day="Friday",
            period="AM", session_type="wfh", room_id=None,
        ).status_code == 422

    def test_week_out_of_range_422(self, client, seeded_nurses):
        assert self._post(
            client, doctor_id=seeded_nurses["nurse_n2"], week=5, day="Friday",
            period="AM", session_type="admin_time", room_id=None,
        ).status_code == 422

    def test_taking_a_doctors_room_409s_and_writes_nothing(
        self, client, seeded_nurses, db_session
    ):
        before = db_session.query(MasterRotaSession).count()
        resp = self._post(
            client, doctor_id=seeded_nurses["nurse_n2"], week=1, day="Monday",
            period="AM", session_type="pre_assigned",
            room_id=seeded_nurses["room_d1"],
        )
        assert resp.status_code == 409
        assert "AA" in resp.json()["detail"]
        db_session.expire_all()
        assert db_session.query(MasterRotaSession).count() == before
        aa = db_session.get(MasterRotaSession, seeded_nurses["aa_session"])
        assert aa.room_id == seeded_nurses["room_d1"]

    def test_displaces_a_nurse(self, client, seeded_nurses, db_session):
        resp = self._post(
            client, doctor_id=seeded_nurses["nurse_n2"], week=1, day="Monday",
            period="AM", session_type="pre_assigned",
            room_id=seeded_nurses["room_tr1"],
        )
        assert resp.status_code == 201, resp.text
        displaced = resp.json()["displaced_session"]
        assert displaced["session_id"] == seeded_nurses["n1_session"]
        assert displaced["room_id"] is None
        assert displaced["session_type"] == "requires_room"


class TestNurseSessionDelete:
    def test_deletes(self, client, seeded_nurses, db_session):
        resp = client.delete(
            f"{NURSE_ROTA}/sessions/{seeded_nurses['n1_session']}"
        )
        assert resp.status_code == 204
        db_session.expire_all()
        assert db_session.get(
            MasterRotaSession, seeded_nurses["n1_session"]
        ) is None

    def test_unknown_404(self, client, seeded_nurses):
        assert client.delete(f"{NURSE_ROTA}/sessions/99999").status_code == 404

    def test_non_nurse_session_404_and_survives(
        self, client, seeded_nurses, db_session
    ):
        resp = client.delete(
            f"{NURSE_ROTA}/sessions/{seeded_nurses['aa_session']}"
        )
        assert resp.status_code == 404
        db_session.expire_all()
        assert db_session.get(
            MasterRotaSession, seeded_nurses["aa_session"]
        ) is not None
