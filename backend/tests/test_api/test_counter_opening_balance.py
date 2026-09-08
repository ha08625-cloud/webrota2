"""Counter opening balance endpoints (counter opening balances plan, Task 3).

Covers the API half of the balance: the two GETs now carrying
`opening_balance`, the clinic GET returning the full counted-doctor x
clinic-type cross-product rather than only the rows that exist, the two
upserts, and the four reset endpoints clearing the balance alongside the
count.

`opening_balance` crosses the wire as a JSON *string*, like every other
Decimal on this API (`DoctorOut.sessions_per_week`, the leave entitlement
figures), so the assertions compare against strings deliberately.
"""
from decimal import Decimal

from app.models import ClinicCounter, ClinicType, Doctor, SystemCounter
from app.models.enums import DoctorType, SystemCounterType

from .conftest import make_clinic_type_via_api

CLINIC_BALANCE_URL = "/api/v1/counters/clinic/opening-balance"


def _clinic_row(client, doctor_code, clinic_type_name="Dragon"):
    listed = client.get("/api/v1/counters/clinic").json()
    return next(
        c for c in listed
        if c["doctor_code"] == doctor_code and c["clinic_type_name"] == clinic_type_name
    )


class TestClinicList:
    def test_returns_cross_product_with_null_ids(self, client, seeded):
        """A doctor who has never been allocated a clinic type still gets a
        row for it -- the whole point, since that doctor is the new joiner the
        balance exists for."""
        make_clinic_type_via_api(client, seeded)

        listed = client.get("/api/v1/counters/clinic").json()
        assert len(listed) == 2  # AA, BB x one clinic type
        for row in listed:
            assert row["id"] is None
            assert row["raw_count"] == 0
            assert row["opening_balance"] == "0.0"

    def test_existing_row_reports_its_values(self, client, db_session, seeded):
        clinic_type = make_clinic_type_via_api(client, seeded)
        db_session.add(ClinicCounter(
            doctor_id=seeded["doctor_aa"],
            clinic_type_id=clinic_type["id"],
            raw_count=5,
            opening_balance=Decimal("3.2"),
        ))
        db_session.commit()

        row = _clinic_row(client, "AA")
        assert row["id"] is not None
        assert row["raw_count"] == 5
        assert row["opening_balance"] == "3.2"

    def test_disabled_clinic_type_omitted_unless_it_has_a_row(
        self, client, db_session, seeded
    ):
        keep = make_clinic_type_via_api(client, seeded, name="Dragon")
        gone = make_clinic_type_via_api(client, seeded, name="Griffin")
        db_session.add(ClinicCounter(
            doctor_id=seeded["doctor_aa"], clinic_type_id=keep["id"], raw_count=2,
        ))
        for type_id in (keep["id"], gone["id"]):
            db_session.get(ClinicType, type_id).is_enabled = False
        db_session.commit()

        names = {c["clinic_type_name"] for c in client.get("/api/v1/counters/clinic").json()}
        assert names == {"Dragon"}


class TestClinicUpsert:
    def test_creates_the_counter_row(self, client, db_session, seeded):
        clinic_type = make_clinic_type_via_api(client, seeded)
        assert db_session.query(ClinicCounter).count() == 0

        resp = client.put(CLINIC_BALANCE_URL, json={
            "doctor_id": seeded["doctor_aa"],
            "clinic_type_id": clinic_type["id"],
            "sessions": "3.2",
        })
        assert resp.status_code == 200, resp.text
        body = resp.json()
        assert body["doctor_code"] == "AA"
        assert body["clinic_type_name"] == "Dragon"
        assert body["raw_count"] == 0
        assert body["opening_balance"] == "3.2"
        assert body["id"] is not None

        row = db_session.query(ClinicCounter).one()
        assert row.raw_count == 0
        assert row.opening_balance == Decimal("3.2")

    def test_updates_without_touching_the_raw_count(self, client, db_session, seeded):
        clinic_type = make_clinic_type_via_api(client, seeded)
        db_session.add(ClinicCounter(
            doctor_id=seeded["doctor_aa"],
            clinic_type_id=clinic_type["id"],
            raw_count=7,
            opening_balance=Decimal("1.0"),
        ))
        db_session.commit()

        resp = client.put(CLINIC_BALANCE_URL, json={
            "doctor_id": seeded["doctor_aa"],
            "clinic_type_id": clinic_type["id"],
            "sessions": "-2.5",
        })
        assert resp.status_code == 200, resp.text
        assert resp.json()["raw_count"] == 7
        assert resp.json()["opening_balance"] == "-2.5"

        db_session.expire_all()
        row = db_session.query(ClinicCounter).one()
        assert row.raw_count == 7
        assert row.opening_balance == Decimal("-2.5")

    def test_zero_keeps_the_row(self, client, db_session, seeded):
        """Unlike the duty balance's own table, this row also carries a raw
        count, so "no deviation" is not "nothing to store"."""
        clinic_type = make_clinic_type_via_api(client, seeded)
        client.put(CLINIC_BALANCE_URL, json={
            "doctor_id": seeded["doctor_aa"],
            "clinic_type_id": clinic_type["id"],
            "sessions": "4.0",
        })
        resp = client.put(CLINIC_BALANCE_URL, json={
            "doctor_id": seeded["doctor_aa"],
            "clinic_type_id": clinic_type["id"],
            "sessions": "0",
        })
        assert resp.status_code == 200, resp.text
        assert resp.json()["opening_balance"] == "0.0"
        assert db_session.query(ClinicCounter).count() == 1

    def test_unknown_doctor_404(self, client, seeded):
        clinic_type = make_clinic_type_via_api(client, seeded)
        resp = client.put(CLINIC_BALANCE_URL, json={
            "doctor_id": 999999,
            "clinic_type_id": clinic_type["id"],
            "sessions": "1.0",
        })
        assert resp.status_code == 404

    def test_unknown_clinic_type_404(self, client, seeded):
        resp = client.put(CLINIC_BALANCE_URL, json={
            "doctor_id": seeded["doctor_aa"],
            "clinic_type_id": 999999,
            "sessions": "1.0",
        })
        assert resp.status_code == 404

    def test_two_decimal_places_422(self, client, seeded):
        clinic_type = make_clinic_type_via_api(client, seeded)
        resp = client.put(CLINIC_BALANCE_URL, json={
            "doctor_id": seeded["doctor_aa"],
            "clinic_type_id": clinic_type["id"],
            "sessions": "3.25",
        })
        assert resp.status_code == 422

    def test_non_counted_doctor_type_allowed(self, client, db_session, seeded):
        """The GETs show Partner/Salaried only, but the engine counts clinics
        for whoever is eligible, so the write is not restricted by type."""
        clinic_type = make_clinic_type_via_api(client, seeded)
        trainee = Doctor(
            code="TT", doctor_type=DoctorType.TRAINEE,
            sessions_per_week=10, active=True,
        )
        db_session.add(trainee)
        db_session.commit()

        resp = client.put(CLINIC_BALANCE_URL, json={
            "doctor_id": trainee.id,
            "clinic_type_id": clinic_type["id"],
            "sessions": "2.0",
        })
        assert resp.status_code == 200, resp.text
        assert resp.json()["doctor_code"] == "TT"


class TestSystemBalance:
    def _counter_id(self, db_session, doctor_id):
        return db_session.query(SystemCounter).filter_by(
            doctor_id=doctor_id, counter_type=SystemCounterType.ROOM_MOVE
        ).one().id

    def test_list_carries_the_balance(self, client, db_session, seeded):
        counter_id = self._counter_id(db_session, seeded["doctor_bb"])
        db_session.get(SystemCounter, counter_id).opening_balance = Decimal("1.5")
        db_session.commit()

        listed = client.get("/api/v1/counters/system").json()
        row = next(c for c in listed if c["id"] == counter_id)
        assert row["opening_balance"] == "1.5"
        assert all(
            c["opening_balance"] == "0.0" for c in listed if c["id"] != counter_id
        )

    def test_upsert(self, client, db_session, seeded):
        counter_id = self._counter_id(db_session, seeded["doctor_aa"])
        db_session.get(SystemCounter, counter_id).raw_count = 6
        db_session.commit()

        resp = client.put(
            f"/api/v1/counters/system/{counter_id}/opening-balance",
            json={"sessions": "2.5"},
        )
        assert resp.status_code == 200, resp.text
        body = resp.json()
        assert body["id"] == counter_id
        assert body["raw_count"] == 6
        assert body["opening_balance"] == "2.5"

        db_session.expire_all()
        assert db_session.get(SystemCounter, counter_id).opening_balance == Decimal("2.5")

    def test_unknown_id_404(self, client, seeded):
        resp = client.put(
            "/api/v1/counters/system/999999/opening-balance", json={"sessions": "1.0"}
        )
        assert resp.status_code == 404

    def test_two_decimal_places_422(self, client, db_session, seeded):
        counter_id = self._counter_id(db_session, seeded["doctor_aa"])
        resp = client.put(
            f"/api/v1/counters/system/{counter_id}/opening-balance",
            json={"sessions": "2.55"},
        )
        assert resp.status_code == 422


class TestResetClearsTheBalance:
    """After a reset every doctor is level at zero by definition, so a
    surviving joiner credit would re-introduce the skew it was created to
    remove."""

    def test_single_clinic_reset(self, client, db_session, seeded):
        clinic_type = make_clinic_type_via_api(client, seeded)
        counter = ClinicCounter(
            doctor_id=seeded["doctor_aa"],
            clinic_type_id=clinic_type["id"],
            raw_count=4,
            opening_balance=Decimal("3.0"),
        )
        db_session.add(counter)
        db_session.commit()

        resp = client.post(f"/api/v1/counters/clinic/{counter.id}/reset")
        assert resp.status_code == 200, resp.text
        assert resp.json()["opening_balance"] == "0.0"

        db_session.expire_all()
        assert db_session.get(ClinicCounter, counter.id).opening_balance == Decimal("0.0")

    def test_single_system_reset(self, client, db_session, seeded):
        counter = db_session.query(SystemCounter).filter_by(
            doctor_id=seeded["doctor_bb"], counter_type=SystemCounterType.SUPERVISION
        ).one()
        counter.raw_count = 3
        counter.opening_balance = Decimal("2.0")
        db_session.commit()

        resp = client.post(f"/api/v1/counters/system/{counter.id}/reset")
        assert resp.status_code == 200, resp.text
        assert resp.json()["opening_balance"] == "0.0"

        db_session.expire_all()
        assert db_session.get(SystemCounter, counter.id).opening_balance == Decimal("0.0")

    def test_clinic_reset_all_including_invisible_rows(
        self, client, db_session, seeded
    ):
        clinic_type = make_clinic_type_via_api(client, seeded)
        trainee = Doctor(
            code="TT", doctor_type=DoctorType.TRAINEE,
            sessions_per_week=10, active=True,
        )
        db_session.add(trainee)
        db_session.flush()
        rows = [
            ClinicCounter(
                doctor_id=seeded["doctor_aa"], clinic_type_id=clinic_type["id"],
                raw_count=4, opening_balance=Decimal("3.0"),
            ),
            ClinicCounter(
                doctor_id=trainee.id, clinic_type_id=clinic_type["id"],
                raw_count=7, opening_balance=Decimal("5.0"),
            ),
        ]
        db_session.add_all(rows)
        db_session.commit()
        ids = [r.id for r in rows]

        assert client.post("/api/v1/counters/clinic/reset-all").status_code == 204

        db_session.expire_all()
        for row_id in ids:
            row = db_session.get(ClinicCounter, row_id)
            assert row.raw_count == 0
            assert row.opening_balance == Decimal("0.0")

    def test_system_reset_all(self, client, db_session, seeded):
        for counter in db_session.query(SystemCounter).all():
            counter.raw_count = 9
            counter.opening_balance = Decimal("4.0")
        db_session.commit()

        assert client.post("/api/v1/counters/system/reset-all").status_code == 204

        db_session.expire_all()
        for counter in db_session.query(SystemCounter).all():
            assert counter.raw_count == 0
            assert counter.opening_balance == Decimal("0.0")
