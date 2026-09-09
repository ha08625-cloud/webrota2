"""Doctor router tests"""
from decimal import Decimal

from sqlalchemy import func, select

from app.api.routers.doctors import NULLED_TABLES, PURGED_MODELS
from app.database import Base
from app.models import Doctor, DutyOpeningBalance, GeneratedRota, SystemCounter, User
from app.models.enums import DoctorType, SystemCounterType

from .conftest import generate_rota


class TestDoctors:
    def test_create_and_get(self, client, seeded):
        resp = client.post("/api/v1/doctors", json={
            "code": "CC", "doctor_type": "Trainee",
        })
        assert resp.status_code == 201
        body = resp.json()
        assert body["sessions_per_week"] == "10.0"
        got = client.get(f"/api/v1/doctors/{body['id']}").json()
        assert got["code"] == "CC"
        assert got["preferred_rooms"] == []

    def test_create_doctor_creates_system_counters(self, client, db_session, seeded):
        """The counter invariant: every doctor gets one row per
        SystemCounterType at creation, regardless of doctor_type --
        deliberately asserted on a Trainee, the type the old seed skipped.
        """
        resp = client.post("/api/v1/doctors", json={
            "code": "CC", "doctor_type": "Trainee",
        })
        assert resp.status_code == 201
        doctor_id = resp.json()["id"]

        rows = db_session.execute(
            select(SystemCounter).where(SystemCounter.doctor_id == doctor_id)
        ).scalars().all()
        assert {r.counter_type for r in rows} == {
            SystemCounterType.ROOM_MOVE,
            SystemCounterType.SUPERVISION,
        }
        assert all(r.raw_count == 0 for r in rows)

    def test_create_doctor_sets_calendar_token(self, client, db_session, seeded):
        """The calendar-token invariant: the router issues a token at
        creation, distinct per doctor, and it never appears in the doctor
        payloads (it reaches the frontend only via the feed endpoint).
        """
        ids = []
        for code in ("CC", "DD"):
            resp = client.post("/api/v1/doctors", json={
                "code": code, "doctor_type": "Trainee",
            })
            assert resp.status_code == 201
            assert "calendar_token" not in resp.json()
            ids.append(resp.json()["id"])

        tokens = [db_session.get(Doctor, i).calendar_token for i in ids]
        assert all(tokens)
        assert tokens[0] != tokens[1]
        assert "calendar_token" not in client.get(f"/api/v1/doctors/{ids[0]}").json()

    def test_duplicate_code_409(self, client, seeded):
        resp = client.post("/api/v1/doctors", json={
            "code": "AA", "doctor_type": "Partner",
        })
        assert resp.status_code == 409

    def test_duplicate_code_leaves_no_counter_rows(self, client, db_session, seeded):
        """The 409 rollback must not strand counter rows: the seeded
        fixture created exactly two rows each for AA and BB, and a failed
        create should leave that count untouched.
        """
        before = len(db_session.execute(select(SystemCounter)).scalars().all())
        resp = client.post("/api/v1/doctors", json={
            "code": "AA", "doctor_type": "Partner",
        })
        assert resp.status_code == 409
        db_session.expire_all()
        after = len(db_session.execute(select(SystemCounter)).scalars().all())
        assert after == before

    def test_patch_partial_update(self, client, seeded):
        resp = client.patch(f"/api/v1/doctors/{seeded['doctor_aa']}", json={
            "sessions_per_week": "6.0",
        })
        assert resp.status_code == 200
        body = resp.json()
        assert body["sessions_per_week"] == "6.0"
        assert body["code"] == "AA"  # untouched

    def test_active_only_filter(self, client, seeded):
        # Deactivation is the PATCH, not the DELETE -- DELETE purges.
        client.patch(f"/api/v1/doctors/{seeded['doctor_bb']}", json={"active": False})
        codes = {d["code"] for d in client.get("/api/v1/doctors").json()}
        assert codes == {"AA"}
        codes_all = {
            d["code"]
            for d in client.get("/api/v1/doctors?active_only=false").json()
        }
        assert codes_all == {"AA", "BB"}

    def test_preferred_rooms_replace(self, client, seeded):
        url = f"/api/v1/doctors/{seeded['doctor_aa']}/preferred-rooms"
        resp = client.put(url, json=[
            {"preference_order": 1, "room_id": seeded["room_d1"]},
            {"preference_order": 2, "room_type": "C"},
        ])
        assert resp.status_code == 200
        assert len(resp.json()["preferred_rooms"]) == 2
        resp = client.put(url, json=[{"preference_order": 1, "room_type": "W"}])
        assert len(resp.json()["preferred_rooms"]) == 1

    def test_create_without_dates_defaults_to_unbounded(self, client, seeded):
        """Null at both ends is the existing behaviour for every row, so a
        create that says nothing about the window must round-trip as
        nulls, not as anything derived."""
        body = client.post("/api/v1/doctors", json={
            "code": "CC", "doctor_type": "Partner",
        }).json()
        assert body["start_date"] is None
        assert body["end_date"] is None
        got = client.get(f"/api/v1/doctors/{body['id']}").json()
        assert got["start_date"] is None and got["end_date"] is None

    def test_create_with_dates_round_trip(self, client, seeded):
        resp = client.post("/api/v1/doctors", json={
            "code": "CC", "doctor_type": "Salaried",
            "start_date": "2026-09-01", "end_date": "2027-03-31",
        })
        assert resp.status_code == 201, resp.text
        body = resp.json()
        assert body["start_date"] == "2026-09-01"
        assert body["end_date"] == "2027-03-31"
        got = client.get(f"/api/v1/doctors/{body['id']}").json()
        assert got["start_date"] == "2026-09-01"
        assert got["end_date"] == "2027-03-31"

    def test_create_start_after_end_422(self, client, seeded):
        resp = client.post("/api/v1/doctors", json={
            "code": "CC", "doctor_type": "Partner",
            "start_date": "2026-09-01", "end_date": "2026-08-31",
        })
        assert resp.status_code == 422
        assert "end_date" in resp.json()["detail"]

    def test_create_one_ended_window_allowed(self, client, seeded):
        """A leaver has an end date and no start date, and vice versa for a
        joiner -- neither half of the pair is required."""
        joiner = client.post("/api/v1/doctors", json={
            "code": "CC", "doctor_type": "Partner", "start_date": "2026-09-01",
        })
        assert joiner.status_code == 201
        assert joiner.json()["end_date"] is None
        leaver = client.post("/api/v1/doctors", json={
            "code": "DD", "doctor_type": "Partner", "end_date": "2026-09-01",
        })
        assert leaver.status_code == 201
        assert leaver.json()["start_date"] is None

    def test_patch_sets_and_clears_window(self, client, seeded):
        url = f"/api/v1/doctors/{seeded['doctor_aa']}"
        body = client.patch(url, json={
            "start_date": "2026-09-01", "end_date": "2027-03-31",
        }).json()
        assert body["start_date"] == "2026-09-01"
        # An explicit null clears; model_fields_set is what distinguishes
        # this from an absent field.
        body = client.patch(url, json={"end_date": None}).json()
        assert body["end_date"] is None
        assert body["start_date"] == "2026-09-01"  # untouched

    def test_patch_merge_start_after_existing_end_422(self, client, seeded):
        """The PATCH-merge case: the payload carries only start_date, and
        it must still be checked against the end_date already on the row.
        A validator on DoctorPatch alone could not see this."""
        url = f"/api/v1/doctors/{seeded['doctor_aa']}"
        assert client.patch(url, json={"end_date": "2026-09-30"}).status_code == 200
        resp = client.patch(url, json={"start_date": "2026-10-05"})
        assert resp.status_code == 422
        assert "end_date" in resp.json()["detail"]
        # Rejected, not partially applied.
        assert client.get(url).json()["start_date"] is None


class TestDeleteDoctor:
    """DELETE is a permanent purge, not a soft delete.

    The old behaviour -- active=False, plus a 409 for anyone with committed
    sessions -- left a deleted doctor and all their rows in place, which is
    what put "(inactive)" rows on the master rota grid after someone thought
    they had removed a leaver. See routers/doctors.py's module docstring.
    """

    def _deactivate(self, client, doctor_id):
        resp = client.patch(f"/api/v1/doctors/{doctor_id}", json={"active": False})
        assert resp.status_code == 200

    def test_active_doctor_409s(self, client, seeded):
        """Deactivate-then-delete is deliberate: it rules out deleting
        someone who is on this week's rota."""
        resp = client.delete(f"/api/v1/doctors/{seeded['doctor_aa']}")
        assert resp.status_code == 409
        assert "deactivate" in resp.json()["detail"].lower()
        assert client.get(f"/api/v1/doctors/{seeded['doctor_aa']}").status_code == 200

    def test_delete_purges_the_doctor_and_their_rows(self, client, db_session, seeded):
        """The whole point: nothing referencing the doctor survives, and a
        committed rota is no longer a blocker."""
        out = generate_rota(client)
        client.post(f"/api/v1/rota/{out['rota_id']}/commit")
        doctor_id = seeded["doctor_aa"]
        self._deactivate(client, doctor_id)

        # A duty opening balance is one of the tables the purge reaches, and
        # nothing else in this fixture creates one.
        db_session.add(
            DutyOpeningBalance(doctor_id=doctor_id, year=2026, sessions=Decimal("3.2"))
        )
        db_session.commit()

        resp = client.delete(f"/api/v1/doctors/{doctor_id}")
        assert resp.status_code == 200, resp.text
        deleted = resp.json()["deleted"]
        assert deleted["duty_opening_balances"] == 1
        # Reported per table, and the counts are real rather than zeroes.
        assert deleted["master_rota_sessions"] == 2
        assert deleted["rota_sessions"] > 0
        assert deleted["system_counters"] == 2

        db_session.expire_all()
        assert db_session.get(Doctor, doctor_id) is None
        for model in PURGED_MODELS:
            remaining = db_session.execute(
                select(func.count())
                .select_from(model)
                .where(model.doctor_id == doctor_id)
            ).scalar_one()
            assert remaining == 0, f"{model.__tablename__} still references the doctor"

        # The doctor is gone from every list, including the active_only=false
        # one the master rota grid reads -- no more "(inactive)" row.
        codes_all = {
            d["code"]
            for d in client.get("/api/v1/doctors?active_only=false").json()
        }
        assert codes_all == {"BB"}

    def test_delete_leaves_the_rota_header_standing(self, client, db_session, seeded):
        """Sessions go; the GeneratedRota row does not. An empty rota is a
        different thing from a rota that was never generated."""
        out = generate_rota(client)
        self._deactivate(client, seeded["doctor_aa"])
        assert client.delete(f"/api/v1/doctors/{seeded['doctor_aa']}").status_code == 200
        db_session.expire_all()
        assert db_session.get(GeneratedRota, out["rota_id"]) is not None

    def test_delete_nulls_the_login_rather_than_deleting_it(
        self, client, db_session, seeded
    ):
        """A user row is a login, not history of the doctor."""
        user = User(
            email="linked@example.com",
            name="Linked",
            password_hash="x",
            doctor_id=seeded["doctor_aa"],
        )
        db_session.add(user)
        db_session.commit()

        self._deactivate(client, seeded["doctor_aa"])
        resp = client.delete(f"/api/v1/doctors/{seeded['doctor_aa']}")
        assert resp.status_code == 200, resp.text
        # Nulled, not purged -- and so not reported among the destroyed rows.
        assert "users" not in resp.json()["deleted"]

        db_session.expire_all()
        refreshed = db_session.get(User, user.id)
        assert refreshed is not None
        assert refreshed.doctor_id is None

    def test_delete_missing_404s(self, client, seeded):
        assert client.delete("/api/v1/doctors/9999").status_code == 404

    def test_usage_reports_what_would_be_destroyed(self, client, seeded):
        out = generate_rota(client)
        client.post(f"/api/v1/rota/{out['rota_id']}/commit")
        usage = client.get(f"/api/v1/doctors/{seeded['doctor_aa']}/usage")
        assert usage.status_code == 200
        body = usage.json()
        assert body["master_sessions"] == 2
        assert body["rota_sessions"] > 0
        assert body["committed_rotas"] == 1

    def test_usage_is_readable_before_deactivating(self, client, seeded):
        """The dialog reads it while deciding, so it must not carry the
        delete's inactive precondition."""
        assert client.get(f"/api/v1/doctors/{seeded['doctor_aa']}/usage").status_code == 200

    # The permission sweeps below build their doctor through db_session:
    # `client` and a permission client cannot be requested by the same test
    # (one shared app.dependency_overrides -- see conftest).
    @staticmethod
    def _inactive_doctor(db):
        doctor = Doctor(code="ZZ", doctor_type=DoctorType.PARTNER, active=False)
        db.add(doctor)
        db.commit()
        return doctor.id

    def test_a_rota_admin_cannot_delete(self, rota_admin_client, db_session):
        """A rota editor passes the router's clinical gate but not the
        endpoint's `user_admin` one: an irreversible, history-destroying
        action is the narrower permission."""
        doctor_id = self._inactive_doctor(db_session)
        assert rota_admin_client.delete(f"/api/v1/doctors/{doctor_id}").status_code == 403
        db_session.expire_all()
        assert db_session.get(Doctor, doctor_id) is not None

    def test_viewer_cannot_delete(self, readonly_client, db_session):
        doctor_id = self._inactive_doctor(db_session)
        assert readonly_client.delete(f"/api/v1/doctors/{doctor_id}").status_code == 403

    def test_manager_can_delete(self, manager_client, db_session):
        doctor_id = self._inactive_doctor(db_session)
        assert manager_client.delete(f"/api/v1/doctors/{doctor_id}").status_code == 200


def test_purged_models_covers_every_fk_to_doctors():
    """The delete is explicit rather than ON DELETE CASCADE, so a new table
    with a doctor FK would silently go unpurged. This is the tripwire."""
    referencing = set()
    for table in Base.metadata.tables.values():
        for column in table.columns:
            for fk in column.foreign_keys:
                if fk.column.table.name == "doctors":
                    referencing.add(table.name)

    assert referencing == {m.__tablename__ for m in PURGED_MODELS} | set(
        NULLED_TABLES
    ), (
        "a table references doctors but is neither purged nor nulled when a "
        "doctor is deleted -- add its model to PURGED_MODELS (or its table to "
        "NULLED_TABLES) in app/api/routers/doctors.py"
    )


class TestCalendarFeed:
    """Token management endpoints (calendar feed plan, Task 4).

    The public feed route itself is tested in
    test_calendar_feed_route.py; what is asserted here is that the token
    the doctors router hands out is the one that route resolves, and that
    rotation needs `user_admin` as well as clinical:write.

    The tier tests deliberately do NOT use the `seeded` fixture: `seeded`
    requests `client`, whose MANAGER stub would overwrite the tier client's
    identity on the shared `app.dependency_overrides` (see the conftest
    docstrings). They build their doctor through `db_session` instead.
    """

    def _token(self, db_session, doctor_id):
        return db_session.get(Doctor, doctor_id).calendar_token

    def _make_doctor(self, db_session):
        doctor = Doctor(code="CF", doctor_type=DoctorType.PARTNER)
        db_session.add(doctor)
        db_session.commit()
        return doctor.id

    def test_get_returns_the_stored_token_and_its_path(
        self, client, db_session, seeded
    ):
        doctor_id = seeded["doctor_aa"]
        body = client.get(f"/api/v1/doctors/{doctor_id}/calendar-feed").json()
        token = self._token(db_session, doctor_id)
        assert body == {
            "doctor_id": doctor_id,
            "token": token,
            "feed_path": f"/api/v1/calendar/{token}.ics",
        }
        # A path, never an absolute URL -- the frontend prepends the origin.
        assert not body["feed_path"].startswith("http")
        # And it is the path that actually serves the feed.
        assert client.get(body["feed_path"]).status_code == 200

    def test_get_unknown_doctor_404(self, client, seeded):
        assert client.get("/api/v1/doctors/9999/calendar-feed").status_code == 404

    def test_rotate_dead_ends_the_old_url(self, client, db_session, seeded):
        """`client` is manager tier, which is what rotation needs; the tier
        boundary itself is tested below."""
        doctor_id = seeded["doctor_aa"]
        old = client.get(f"/api/v1/doctors/{doctor_id}/calendar-feed").json()
        assert client.get(old["feed_path"]).status_code == 200

        resp = client.post(f"/api/v1/doctors/{doctor_id}/calendar-feed/rotate")
        assert resp.status_code == 200
        new = resp.json()
        assert new["token"] != old["token"]

        db_session.expire_all()
        assert self._token(db_session, doctor_id) == new["token"]
        assert client.get(new["feed_path"]).status_code == 200
        assert client.get(old["feed_path"]).status_code == 404

    def test_rotate_unknown_doctor_404(self, client, seeded):
        assert client.post(
            "/api/v1/doctors/9999/calendar-feed/rotate"
        ).status_code == 404

    def test_viewer_can_read_but_not_rotate(self, readonly_client, db_session):
        doctor_id = self._make_doctor(db_session)
        assert readonly_client.get(
            f"/api/v1/doctors/{doctor_id}/calendar-feed"
        ).status_code == 200
        assert readonly_client.post(
            f"/api/v1/doctors/{doctor_id}/calendar-feed/rotate"
        ).status_code == 403

    def test_a_rota_admin_cannot_rotate(self, rota_admin_client, db_session):
        """The router's clinical gate admits every rota editor; the
        endpoint's `user_admin` one is what stops them, which is the whole
        reason it hangs off this endpoint as well."""
        doctor_id = self._make_doctor(db_session)
        assert rota_admin_client.get(
            f"/api/v1/doctors/{doctor_id}/calendar-feed"
        ).status_code == 200
        assert rota_admin_client.post(
            f"/api/v1/doctors/{doctor_id}/calendar-feed/rotate"
        ).status_code == 403

    def test_manager_can_rotate(self, manager_client, db_session):
        doctor_id = self._make_doctor(db_session)
        before = manager_client.get(
            f"/api/v1/doctors/{doctor_id}/calendar-feed"
        ).json()["token"]
        resp = manager_client.post(
            f"/api/v1/doctors/{doctor_id}/calendar-feed/rotate"
        )
        assert resp.status_code == 200
        assert resp.json()["token"] != before
