"""Master rota router tests: GET /master-rota/active."""
from app.database import Base
from app.models import MasterRotaTemplate


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
        assert len(body["sessions"]) == 2

        by_doctor = {s["doctor_id"]: s for s in body["sessions"]}
        aa_session = by_doctor[seeded["doctor_aa"]]
        assert aa_session["doctor_code"] == "AA"
        assert aa_session["session_type"] == "requires_room"
        assert aa_session["room_id"] == seeded["room_c1"]
        assert aa_session["room_code"] == "C1"

        bb_session = by_doctor[seeded["doctor_bb"]]
        assert bb_session["doctor_code"] == "BB"
        assert bb_session["session_type"] == "admin_time"
        assert bb_session["room_id"] is None
        assert bb_session["room_code"] is None

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