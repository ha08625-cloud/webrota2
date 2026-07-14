"""Counter reset endpoint tests (Counter Reset Task 2).

Covers the four reset endpoints added to `backend/app/api/routers/counters.py`:
single clinic/system reset (200, updates in place), reset-all clinic/system
(204, every row including ones invisible to GET), 404 on unknown single-reset
id, the reset-then-scrap interaction (scrap must undo a mid-draft reset by
restoring the pre-generation snapshot), and the auth shim.

Uses the shared `client`/`db_session`/`seeded` fixtures from conftest.py.
`seeded` gives doctors AA (Partner) and BB (Salaried), each with ROOM_MOVE
and SUPERVISION system counters at raw_count=0.
"""
from app.models import ClinicCounter, Doctor, SystemCounter
from app.models.enums import DoctorType, SystemCounterType

from .conftest import generate_rota, make_clinic_type_via_api


class TestSingleClinicReset:
    def test_reset_updates_in_place(self, client, db_session, seeded):
        clinic_type = make_clinic_type_via_api(client, seeded)
        counter = ClinicCounter(
            doctor_id=seeded["doctor_aa"],
            clinic_type_id=clinic_type["id"],
            raw_count=5,
        )
        db_session.add(counter)
        db_session.commit()
        counter_id = counter.id

        resp = client.post(f"/api/v1/counters/clinic/{counter_id}/reset")
        assert resp.status_code == 200, resp.text
        body = resp.json()
        assert body["id"] == counter_id
        assert body["raw_count"] == 0
        assert body["doctor_code"] == "AA"
        assert body["clinic_type_name"] == "Dragon"

        db_session.expire_all()
        row = db_session.get(ClinicCounter, counter_id)
        assert row.raw_count == 0
        assert row.id == counter_id

    def test_reset_unknown_id_404(self, client, seeded):
        resp = client.post("/api/v1/counters/clinic/999999/reset")
        assert resp.status_code == 404


class TestSingleSystemReset:
    def test_reset_updates_in_place(self, client, db_session, seeded):
        counter = db_session.query(SystemCounter).filter_by(
            doctor_id=seeded["doctor_bb"], counter_type=SystemCounterType.ROOM_MOVE
        ).one()
        counter.raw_count = 3
        db_session.commit()
        counter_id = counter.id

        resp = client.post(f"/api/v1/counters/system/{counter_id}/reset")
        assert resp.status_code == 200, resp.text
        body = resp.json()
        assert body["id"] == counter_id
        assert body["raw_count"] == 0
        assert body["doctor_code"] == "BB"
        assert body["counter_type"] == "room_move"

        db_session.expire_all()
        refreshed = db_session.get(SystemCounter, counter_id)
        assert refreshed.raw_count == 0
        assert refreshed.id == counter_id

    def test_reset_unknown_id_404(self, client, seeded):
        resp = client.post("/api/v1/counters/system/999999/reset")
        assert resp.status_code == 404


class TestResetAllClinic:
    def test_reset_all_zeroes_every_row_including_invisible_ones(
        self, client, db_session, seeded
    ):
        clinic_type = make_clinic_type_via_api(client, seeded)

        trainee = Doctor(
            code="TT", doctor_type=DoctorType.TRAINEE,
            sessions_per_week=10, active=True,
        )
        db_session.add(trainee)
        db_session.flush()

        partner_counter = ClinicCounter(
            doctor_id=seeded["doctor_aa"],
            clinic_type_id=clinic_type["id"], raw_count=4,
        )
        trainee_counter = ClinicCounter(
            doctor_id=trainee.id,
            clinic_type_id=clinic_type["id"], raw_count=7,
        )
        db_session.add_all([partner_counter, trainee_counter])
        db_session.commit()

        # Trainee row is invisible to the GET endpoint (Partner/Salaried only).
        visible = {
            c["doctor_code"] for c in client.get("/api/v1/counters/clinic").json()
        }
        assert visible == {"AA"}

        resp = client.post("/api/v1/counters/clinic/reset-all")
        assert resp.status_code == 204

        db_session.expire_all()
        assert db_session.get(ClinicCounter, partner_counter.id).raw_count == 0
        assert db_session.get(ClinicCounter, trainee_counter.id).raw_count == 0


class TestResetAllSystem:
    def test_reset_all_zeroes_every_row(self, client, db_session, seeded):
        counters = db_session.query(SystemCounter).all()
        for c in counters:
            c.raw_count = 9
        db_session.commit()
        counter_ids = [c.id for c in counters]
        assert len(counter_ids) == 4  # AA/BB x ROOM_MOVE/SUPERVISION

        resp = client.post("/api/v1/counters/system/reset-all")
        assert resp.status_code == 204

        db_session.expire_all()
        for cid in counter_ids:
            assert db_session.get(SystemCounter, cid).raw_count == 0


class TestResetThenScrap:
    def test_scrap_reverts_a_mid_draft_reset(self, client, db_session, seeded):
        # Give a pre-generation non-zero value to a system counter that
        # generation will snapshot before it does anything else.
        counter = db_session.query(SystemCounter).filter_by(
            doctor_id=seeded["doctor_aa"], counter_type=SystemCounterType.ROOM_MOVE
        ).one()
        counter.raw_count = 6
        db_session.commit()
        counter_id = counter.id

        out = generate_rota(client)

        # Mid-draft: reset the counter to zero via the new endpoint.
        resp = client.post(f"/api/v1/counters/system/{counter_id}/reset")
        assert resp.status_code == 200
        assert resp.json()["raw_count"] == 0

        db_session.expire_all()
        assert db_session.get(SystemCounter, counter_id).raw_count == 0

        # Scrapping the draft must undo the reset, restoring the
        # pre-generation value of 6 -- not leave it at 0 and not treat the
        # reset as something scrap should preserve.
        resp = client.delete(f"/api/v1/rota/{out['rota_id']}")
        assert resp.status_code == 204

        db_session.expire_all()
        assert db_session.get(SystemCounter, counter_id).raw_count == 6


class TestAuth:
    def test_reset_without_token_401_when_env_set(self, client, seeded, monkeypatch):
        monkeypatch.setenv("API_TOKEN", "s3cret")
        resp = client.post("/api/v1/counters/clinic/reset-all")
        assert resp.status_code == 401