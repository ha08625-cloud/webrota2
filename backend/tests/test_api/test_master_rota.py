"""Master rota router tests: GET /master-rota/active."""
from app.models import MasterRotaSession, MasterRotaTemplate
from app.models.enums import Day, MasterSessionType, Period


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