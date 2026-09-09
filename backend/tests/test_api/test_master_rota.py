"""Master rota router tests: GET /master-rota/active, the M4.3 Task 1
PATCH /master-rota/templates/{template_id}/sessions/{session_id}, and the
M4.4 Task 1 POST/DELETE on the same collection."""
from app.models import MasterRotaSession, MasterRotaTemplate
from app.models.enums import Day, MasterSessionType, Period


def _session_id(body, doctor_id, period, day="Monday", week=1):
    return next(
        s["session_id"] for s in body["sessions"]
        if s["doctor_id"] == doctor_id and s["period"] == period
        and s["day"] == day and s["week"] == week
    )


class TestMasterRota:
    def test_no_active_template_404(self, client):
        resp = client.get("/api/v1/master-rota/active")
        assert resp.status_code == 404

    def test_active_template_found_with_joins(self, client, seeded):
        resp = client.get("/api/v1/master-rota/active")
        assert resp.status_code == 200, resp.text
        body = resp.json()
        assert body["template_id"] == seeded["template"]
        assert body["name"] == "Default"
        # seeded (test_api_conftest.py): AA and BB, Monday AM + PM, all
        # REQUIRES_ROOM, no room assigned.
        assert len(body["sessions"]) == 4

        aa_sessions = [s for s in body["sessions"] if s["doctor_id"] == seeded["doctor_aa"]]
        assert len(aa_sessions) == 2
        assert {s["period"] for s in aa_sessions} == {"AM", "PM"}
        for s in aa_sessions:
            assert s["doctor_code"] == "AA"
            assert s["doctor_type"] == "Partner"
            assert s["session_type"] == "requires_room"
            assert s["room_id"] is None
            assert s["room_code"] is None

        bb_sessions = [s for s in body["sessions"] if s["doctor_id"] == seeded["doctor_bb"]]
        assert len(bb_sessions) == 2
        assert all(s["doctor_code"] == "BB" for s in bb_sessions)
        assert all(s["doctor_type"] == "Salaried" for s in bb_sessions)

    def test_room_code_join(self, client, seeded, db_session):
        db_session.add(MasterRotaSession(
            template_id=seeded["template"], doctor_id=seeded["doctor_aa"], week=2,
            day=Day.TUESDAY, period=Period.AM,
            session_type=MasterSessionType.PRE_ASSIGNED, room_id=seeded["room_c1"],
        ))
        db_session.commit()

        resp = client.get("/api/v1/master-rota/active")
        assert resp.status_code == 200
        added = next(
            s for s in resp.json()["sessions"]
            if s["week"] == 2 and s["day"] == "Tuesday"
        )
        assert added["room_id"] == seeded["room_c1"]
        assert added["room_code"] == "C1"

    def test_inactive_template_not_returned(self, client, seeded, db_session):
        db_session.add(MasterRotaTemplate(name="Old", is_active=False))
        db_session.commit()
        resp = client.get("/api/v1/master-rota/active")
        assert resp.status_code == 200
        assert resp.json()["template_id"] == seeded["template"]

    def test_multiple_active_templates_deterministic_not_500(self, client, seeded, db_session):
        # Schema allows a second is_active=True row (no partial unique
        # constraint) -- the endpoint must pick one deterministically
        # (lowest id) rather than 500 via scalar_one().
        second = MasterRotaTemplate(name="Second", is_active=True)
        db_session.add(second)
        db_session.commit()

        resp = client.get("/api/v1/master-rota/active")
        assert resp.status_code == 200
        assert resp.json()["template_id"] == seeded["template"]


class TestMasterRotaSessionPatch:
    def _patch(self, client, template_id, session_id, **payload):
        return client.patch(
            f"/api/v1/master-rota/templates/{template_id}/sessions/{session_id}",
            json=payload,
        )

    # -- Happy path per type --------------------------------------------

    def test_set_no_surgery_clears_room(self, client, seeded):
        body = client.get("/api/v1/master-rota/active").json()
        sid = _session_id(body, seeded["doctor_aa"], "AM")
        resp = self._patch(
            client, seeded["template"], sid,
            session_type="no_surgery", room_id=None,
        )
        assert resp.status_code == 200, resp.text
        out = resp.json()
        assert out["session"]["session_type"] == "no_surgery"
        assert out["session"]["room_id"] is None
        assert out["displaced_session"] is None

    def test_set_pre_assigned_with_room(self, client, seeded):
        body = client.get("/api/v1/master-rota/active").json()
        sid = _session_id(body, seeded["doctor_aa"], "AM")
        resp = self._patch(
            client, seeded["template"], sid,
            session_type="pre_assigned", room_id=seeded["room_c1"],
        )
        assert resp.status_code == 200, resp.text
        out = resp.json()["session"]
        assert out["session_type"] == "pre_assigned"
        assert out["room_id"] == seeded["room_c1"]
        assert out["room_code"] == "C1"
        # Joined fields present on the patch response, not just GET.
        assert out["doctor_code"] == "AA"
        assert out["doctor_type"] == "Partner"

    def test_set_admin_time_without_room(self, client, seeded):
        body = client.get("/api/v1/master-rota/active").json()
        sid = _session_id(body, seeded["doctor_aa"], "AM")
        resp = self._patch(
            client, seeded["template"], sid,
            session_type="admin_time", room_id=None,
        )
        assert resp.status_code == 200, resp.text
        assert resp.json()["session"]["session_type"] == "admin_time"
        assert resp.json()["session"]["room_id"] is None

    def test_set_admin_time_with_room(self, client, seeded):
        body = client.get("/api/v1/master-rota/active").json()
        sid = _session_id(body, seeded["doctor_aa"], "AM")
        resp = self._patch(
            client, seeded["template"], sid,
            session_type="admin_time", room_id=seeded["room_d1"],
        )
        assert resp.status_code == 200, resp.text
        out = resp.json()["session"]
        assert out["session_type"] == "admin_time"
        assert out["room_id"] == seeded["room_d1"]

    def test_set_wfh(self, client, seeded):
        body = client.get("/api/v1/master-rota/active").json()
        sid = _session_id(body, seeded["doctor_aa"], "AM")
        resp = self._patch(
            client, seeded["template"], sid,
            session_type="wfh", room_id=None,
        )
        assert resp.status_code == 200, resp.text
        assert resp.json()["session"]["session_type"] == "wfh"

    # -- 422s -------------------------------------------------------------

    def test_pre_assigned_without_room_422(self, client, seeded):
        body = client.get("/api/v1/master-rota/active").json()
        sid = _session_id(body, seeded["doctor_aa"], "AM")
        resp = self._patch(
            client, seeded["template"], sid,
            session_type="pre_assigned", room_id=None,
        )
        assert resp.status_code == 422

    def test_requires_room_with_room_422(self, client, seeded):
        body = client.get("/api/v1/master-rota/active").json()
        sid = _session_id(body, seeded["doctor_aa"], "AM")
        resp = self._patch(
            client, seeded["template"], sid,
            session_type="requires_room", room_id=seeded["room_c1"],
        )
        assert resp.status_code == 422

    def test_no_surgery_with_room_422(self, client, seeded):
        body = client.get("/api/v1/master-rota/active").json()
        sid = _session_id(body, seeded["doctor_aa"], "AM")
        resp = self._patch(
            client, seeded["template"], sid,
            session_type="no_surgery", room_id=seeded["room_c1"],
        )
        assert resp.status_code == 422

    def test_wfh_with_room_422(self, client, seeded):
        body = client.get("/api/v1/master-rota/active").json()
        sid = _session_id(body, seeded["doctor_aa"], "AM")
        resp = self._patch(
            client, seeded["template"], sid,
            session_type="wfh", room_id=seeded["room_c1"],
        )
        assert resp.status_code == 422

    def test_missing_field_422(self, client, seeded):
        body = client.get("/api/v1/master-rota/active").json()
        sid = _session_id(body, seeded["doctor_aa"], "AM")
        resp = client.patch(
            f"/api/v1/master-rota/templates/{seeded['template']}/sessions/{sid}",
            json={"session_type": "no_surgery"},
        )
        assert resp.status_code == 422

    # -- 404s ---------------------------------------------------------------

    def test_unknown_session_404(self, client, seeded):
        resp = self._patch(
            client, seeded["template"], 999999,
            session_type="no_surgery", room_id=None,
        )
        assert resp.status_code == 404

    def test_session_belongs_to_different_template_404(
        self, client, seeded, db_session
    ):
        other = MasterRotaTemplate(name="Other", is_active=False)
        db_session.add(other)
        db_session.commit()
        body = client.get("/api/v1/master-rota/active").json()
        sid = _session_id(body, seeded["doctor_aa"], "AM")
        resp = self._patch(
            client, other.id, sid,
            session_type="no_surgery", room_id=None,
        )
        assert resp.status_code == 404

    def test_unknown_template_404(self, client, seeded):
        body = client.get("/api/v1/master-rota/active").json()
        sid = _session_id(body, seeded["doctor_aa"], "AM")
        resp = self._patch(
            client, 999999, sid,
            session_type="no_surgery", room_id=None,
        )
        assert resp.status_code == 404

    def test_unknown_room_404(self, client, seeded):
        body = client.get("/api/v1/master-rota/active").json()
        sid = _session_id(body, seeded["doctor_aa"], "AM")
        resp = self._patch(
            client, seeded["template"], sid,
            session_type="pre_assigned", room_id=999999,
        )
        assert resp.status_code == 404

    # -- Displacement ---------------------------------------------------

    def test_displacement_clears_holder_room(self, client, seeded):
        body = client.get("/api/v1/master-rota/active").json()
        aa_am = _session_id(body, seeded["doctor_aa"], "AM")
        bb_am = _session_id(body, seeded["doctor_bb"], "AM")

        # BB holds C1 first.
        r1 = self._patch(
            client, seeded["template"], bb_am,
            session_type="pre_assigned", room_id=seeded["room_c1"],
        )
        assert r1.status_code == 200, r1.text

        # AA takes C1 in the same slot -- BB is displaced.
        r2 = self._patch(
            client, seeded["template"], aa_am,
            session_type="pre_assigned", room_id=seeded["room_c1"],
        )
        assert r2.status_code == 200, r2.text
        out = r2.json()
        assert out["session"]["room_id"] == seeded["room_c1"]
        assert out["displaced_session"]["session_id"] == bb_am
        assert out["displaced_session"]["room_id"] is None
        assert out["displaced_session"]["room_code"] is None

    def test_displaced_pre_assigned_becomes_requires_room(self, client, seeded):
        body = client.get("/api/v1/master-rota/active").json()
        aa_am = _session_id(body, seeded["doctor_aa"], "AM")
        bb_am = _session_id(body, seeded["doctor_bb"], "AM")

        self._patch(
            client, seeded["template"], bb_am,
            session_type="pre_assigned", room_id=seeded["room_c1"],
        )
        r2 = self._patch(
            client, seeded["template"], aa_am,
            session_type="pre_assigned", room_id=seeded["room_c1"],
        )
        assert r2.json()["displaced_session"]["session_type"] == "requires_room"

    def test_displaced_admin_time_keeps_type(self, client, seeded):
        body = client.get("/api/v1/master-rota/active").json()
        aa_am = _session_id(body, seeded["doctor_aa"], "AM")
        bb_am = _session_id(body, seeded["doctor_bb"], "AM")

        self._patch(
            client, seeded["template"], bb_am,
            session_type="admin_time", room_id=seeded["room_c1"],
        )
        r2 = self._patch(
            client, seeded["template"], aa_am,
            session_type="pre_assigned", room_id=seeded["room_c1"],
        )
        out = r2.json()
        assert out["displaced_session"]["session_type"] == "admin_time"
        assert out["displaced_session"]["room_id"] is None

    def test_different_week_holder_not_displaced(
        self, client, seeded, db_session
    ):
        # A week-2 PRE_ASSIGNED holder of C1 in the same day/period.
        week2 = MasterRotaSession(
            template_id=seeded["template"], doctor_id=seeded["doctor_bb"], week=2,
            day=Day.MONDAY, period=Period.AM,
            session_type=MasterSessionType.PRE_ASSIGNED, room_id=seeded["room_c1"],
        )
        db_session.add(week2)
        db_session.commit()
        week2_id = week2.id

        body = client.get("/api/v1/master-rota/active").json()
        aa_am = _session_id(body, seeded["doctor_aa"], "AM")
        resp = self._patch(
            client, seeded["template"], aa_am,
            session_type="pre_assigned", room_id=seeded["room_c1"],
        )
        assert resp.status_code == 200, resp.text
        assert resp.json()["displaced_session"] is None

        still_holds = client.get("/api/v1/master-rota/active").json()
        week2_session = next(
            s for s in still_holds["sessions"] if s["session_id"] == week2_id
        )
        assert week2_session["room_id"] == seeded["room_c1"]

    def test_self_reassign_current_room_is_noop(self, client, seeded):
        body = client.get("/api/v1/master-rota/active").json()
        aa_am = _session_id(body, seeded["doctor_aa"], "AM")
        self._patch(
            client, seeded["template"], aa_am,
            session_type="pre_assigned", room_id=seeded["room_c1"],
        )
        resp = self._patch(
            client, seeded["template"], aa_am,
            session_type="pre_assigned", room_id=seeded["room_c1"],
        )
        assert resp.status_code == 200, resp.text
        out = resp.json()
        assert out["session"]["room_id"] == seeded["room_c1"]
        assert out["displaced_session"] is None


class TestMasterRotaSessionCreate:
    """M4.4 Task 1: POST /master-rota/templates/{template_id}/sessions.

    seeded only gives AA/BB Monday AM+PM, so Tuesday (or any other
    day/period) is always a free slot to create into."""

    def _create(self, client, template_id, **payload):
        return client.post(
            f"/api/v1/master-rota/templates/{template_id}/sessions",
            json=payload,
        )

    # -- Happy path per type ------------------------------------------------

    def test_create_requires_room(self, client, seeded):
        resp = self._create(
            client, seeded["template"],
            doctor_id=seeded["doctor_aa"], week=1, day="Tuesday", period="AM",
            session_type="requires_room", room_id=None,
        )
        assert resp.status_code == 201, resp.text
        out = resp.json()
        assert out["session"]["session_type"] == "requires_room"
        assert out["session"]["room_id"] is None
        assert out["session"]["doctor_code"] == "AA"
        assert out["session"]["doctor_type"] == "Partner"
        assert out["displaced_session"] is None

    def test_create_pre_assigned_with_room(self, client, seeded):
        resp = self._create(
            client, seeded["template"],
            doctor_id=seeded["doctor_aa"], week=1, day="Tuesday", period="AM",
            session_type="pre_assigned", room_id=seeded["room_c1"],
        )
        assert resp.status_code == 201, resp.text
        out = resp.json()["session"]
        assert out["session_type"] == "pre_assigned"
        assert out["room_id"] == seeded["room_c1"]
        assert out["room_code"] == "C1"

    def test_create_admin_time_without_room(self, client, seeded):
        resp = self._create(
            client, seeded["template"],
            doctor_id=seeded["doctor_aa"], week=1, day="Tuesday", period="AM",
            session_type="admin_time", room_id=None,
        )
        assert resp.status_code == 201, resp.text
        assert resp.json()["session"]["session_type"] == "admin_time"

    def test_create_admin_time_with_room(self, client, seeded):
        resp = self._create(
            client, seeded["template"],
            doctor_id=seeded["doctor_aa"], week=1, day="Tuesday", period="AM",
            session_type="admin_time", room_id=seeded["room_d1"],
        )
        assert resp.status_code == 201, resp.text
        assert resp.json()["session"]["room_id"] == seeded["room_d1"]

    def test_create_no_surgery(self, client, seeded):
        resp = self._create(
            client, seeded["template"],
            doctor_id=seeded["doctor_aa"], week=1, day="Tuesday", period="AM",
            session_type="no_surgery", room_id=None,
        )
        assert resp.status_code == 201, resp.text
        assert resp.json()["session"]["session_type"] == "no_surgery"

    def test_create_wfh(self, client, seeded):
        resp = self._create(
            client, seeded["template"],
            doctor_id=seeded["doctor_aa"], week=1, day="Tuesday", period="AM",
            session_type="wfh", room_id=None,
        )
        assert resp.status_code == 201, resp.text
        assert resp.json()["session"]["session_type"] == "wfh"

    # -- 422s -----------------------------------------------------------

    def test_create_pre_assigned_without_room_422(self, client, seeded):
        resp = self._create(
            client, seeded["template"],
            doctor_id=seeded["doctor_aa"], week=1, day="Tuesday", period="AM",
            session_type="pre_assigned", room_id=None,
        )
        assert resp.status_code == 422

    def test_create_requires_room_with_room_422(self, client, seeded):
        resp = self._create(
            client, seeded["template"],
            doctor_id=seeded["doctor_aa"], week=1, day="Tuesday", period="AM",
            session_type="requires_room", room_id=seeded["room_c1"],
        )
        assert resp.status_code == 422

    def test_create_week_zero_422(self, client, seeded):
        resp = self._create(
            client, seeded["template"],
            doctor_id=seeded["doctor_aa"], week=0, day="Tuesday", period="AM",
            session_type="no_surgery", room_id=None,
        )
        assert resp.status_code == 422

    def test_create_week_five_422(self, client, seeded):
        resp = self._create(
            client, seeded["template"],
            doctor_id=seeded["doctor_aa"], week=5, day="Tuesday", period="AM",
            session_type="no_surgery", room_id=None,
        )
        assert resp.status_code == 422

    # -- 404s -------------------------------------------------------------

    def test_create_unknown_template_404(self, client, seeded):
        resp = self._create(
            client, 999999,
            doctor_id=seeded["doctor_aa"], week=1, day="Tuesday", period="AM",
            session_type="no_surgery", room_id=None,
        )
        assert resp.status_code == 404

    def test_create_unknown_doctor_404(self, client, seeded):
        resp = self._create(
            client, seeded["template"],
            doctor_id=999999, week=1, day="Tuesday", period="AM",
            session_type="no_surgery", room_id=None,
        )
        assert resp.status_code == 404

    def test_create_unknown_room_404(self, client, seeded):
        resp = self._create(
            client, seeded["template"],
            doctor_id=seeded["doctor_aa"], week=1, day="Tuesday", period="AM",
            session_type="pre_assigned", room_id=999999,
        )
        assert resp.status_code == 404

    # -- 409 duplicate slot ------------------------------------------------

    def test_create_duplicate_slot_409(self, client, seeded):
        # AA already has Monday AM (seeded).
        resp = self._create(
            client, seeded["template"],
            doctor_id=seeded["doctor_aa"], week=1, day="Monday", period="AM",
            session_type="no_surgery", room_id=None,
        )
        assert resp.status_code == 409

        # The pre-existing row is untouched.
        body = client.get("/api/v1/master-rota/active").json()
        aa_am = next(
            s for s in body["sessions"]
            if s["doctor_id"] == seeded["doctor_aa"] and s["day"] == "Monday"
            and s["period"] == "AM"
        )
        assert aa_am["session_type"] == "requires_room"

    # -- Displacement -------------------------------------------------------

    def test_create_displaces_same_slot_holder(self, client, seeded):
        # BB takes C1 on Tuesday AM week 1 first.
        r1 = self._create(
            client, seeded["template"],
            doctor_id=seeded["doctor_bb"], week=1, day="Tuesday", period="AM",
            session_type="pre_assigned", room_id=seeded["room_c1"],
        )
        assert r1.status_code == 201, r1.text
        bb_session_id = r1.json()["session"]["session_id"]

        # AA is created into the same slot taking C1 -- BB is displaced.
        r2 = self._create(
            client, seeded["template"],
            doctor_id=seeded["doctor_aa"], week=1, day="Tuesday", period="AM",
            session_type="pre_assigned", room_id=seeded["room_c1"],
        )
        assert r2.status_code == 201, r2.text
        out = r2.json()
        assert out["session"]["room_id"] == seeded["room_c1"]
        assert out["displaced_session"]["session_id"] == bb_session_id
        assert out["displaced_session"]["room_id"] is None
        assert out["displaced_session"]["session_type"] == "requires_room"

    def test_create_different_week_holder_not_displaced(self, client, seeded):
        r1 = self._create(
            client, seeded["template"],
            doctor_id=seeded["doctor_bb"], week=2, day="Tuesday", period="AM",
            session_type="pre_assigned", room_id=seeded["room_c1"],
        )
        assert r1.status_code == 201, r1.text
        bb_session_id = r1.json()["session"]["session_id"]

        r2 = self._create(
            client, seeded["template"],
            doctor_id=seeded["doctor_aa"], week=1, day="Tuesday", period="AM",
            session_type="pre_assigned", room_id=seeded["room_c1"],
        )
        assert r2.status_code == 201, r2.text
        assert r2.json()["displaced_session"] is None

        still_holds = client.get("/api/v1/master-rota/active").json()
        bb_session = next(
            s for s in still_holds["sessions"] if s["session_id"] == bb_session_id
        )
        assert bb_session["room_id"] == seeded["room_c1"]


class TestMasterRotaSessionDelete:
    """M4.4 Task 1: DELETE /master-rota/templates/{template_id}/sessions/{session_id}."""

    def _delete(self, client, template_id, session_id):
        return client.delete(
            f"/api/v1/master-rota/templates/{template_id}/sessions/{session_id}"
        )

    def test_delete_happy_path(self, client, seeded):
        body = client.get("/api/v1/master-rota/active").json()
        aa_am = _session_id(body, seeded["doctor_aa"], "AM")

        resp = self._delete(client, seeded["template"], aa_am)
        assert resp.status_code == 204
        assert resp.content == b""

        after = client.get("/api/v1/master-rota/active").json()
        assert all(s["session_id"] != aa_am for s in after["sessions"])
        assert len(after["sessions"]) == 3

    def test_delete_unknown_session_404(self, client, seeded):
        resp = self._delete(client, seeded["template"], 999999)
        assert resp.status_code == 404

    def test_delete_wrong_template_404(self, client, seeded, db_session):
        other = MasterRotaTemplate(name="Other", is_active=False)
        db_session.add(other)
        db_session.commit()
        body = client.get("/api/v1/master-rota/active").json()
        aa_am = _session_id(body, seeded["doctor_aa"], "AM")

        resp = self._delete(client, other.id, aa_am)
        assert resp.status_code == 404

        # Row untouched.
        still_there = client.get("/api/v1/master-rota/active").json()
        assert any(s["session_id"] == aa_am for s in still_there["sessions"])

    def test_delete_unknown_template_404(self, client, seeded):
        body = client.get("/api/v1/master-rota/active").json()
        aa_am = _session_id(body, seeded["doctor_aa"], "AM")
        resp = self._delete(client, 999999, aa_am)
        assert resp.status_code == 404

    def test_delete_then_recreate_same_slot_succeeds(self, client, seeded):
        body = client.get("/api/v1/master-rota/active").json()
        aa_am = _session_id(body, seeded["doctor_aa"], "AM")

        del_resp = self._delete(client, seeded["template"], aa_am)
        assert del_resp.status_code == 204

        recreate = client.post(
            f"/api/v1/master-rota/templates/{seeded['template']}/sessions",
            json={
                "doctor_id": seeded["doctor_aa"], "week": 1,
                "day": "Monday", "period": "AM",
                "session_type": "no_surgery", "room_id": None,
            },
        )
        assert recreate.status_code == 201, recreate.text
        assert recreate.json()["session"]["session_type"] == "no_surgery"