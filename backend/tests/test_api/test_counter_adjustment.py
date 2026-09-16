"""Counter adjustment endpoints (counter adjustments plan, Task 2).

Covers the API half of the adjustment: the two GETs carrying `adjustment`,
the clinic GET returning the full counted-doctor x clinic-type cross-product
rather than only the rows that exist, the two upserts, and the four reset
endpoints clearing the adjustment alongside the count.

The upserts take a **target effective total** (`target_count`), not a credit:
the admin types the number the counter should read and the server stores
`target_count - raw_count`. The assertions below are written around that
distinction -- every upsert case checks the *stored delta* against the target
that was sent.

`adjustment` crosses the wire as a JSON *string*, like every other
Decimal on this API (`DoctorOut.sessions_per_week`, the leave entitlement
figures), so the assertions compare against strings deliberately.
"""
from decimal import Decimal

from app.models import ClinicCounter, ClinicType, Doctor, SystemCounter
from app.models.enums import DoctorType, SystemCounterType

from .conftest import make_clinic_type_via_api

CLINIC_ADJUSTMENT_URL = "/api/v1/counters/clinic/adjustment"


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
        adjustment exists for."""
        make_clinic_type_via_api(client, seeded)

        listed = client.get("/api/v1/counters/clinic").json()
        assert len(listed) == 2  # AA, BB x one clinic type
        for row in listed:
            assert row["id"] is None
            assert row["raw_count"] == 0
            assert row["adjustment"] == "0.0"

    def test_existing_row_reports_its_values(self, client, db_session, seeded):
        clinic_type = make_clinic_type_via_api(client, seeded)
        db_session.add(ClinicCounter(
            doctor_id=seeded["doctor_aa"],
            clinic_type_id=clinic_type["id"],
            raw_count=5,
            adjustment=Decimal("3.2"),
        ))
        db_session.commit()

        row = _clinic_row(client, "AA")
        assert row["id"] is not None
        assert row["raw_count"] == 5
        assert row["adjustment"] == "3.2"

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
        """A pair with no row yet has a raw count of zero, so the whole target
        becomes the adjustment."""
        clinic_type = make_clinic_type_via_api(client, seeded)
        assert db_session.query(ClinicCounter).count() == 0

        resp = client.put(CLINIC_ADJUSTMENT_URL, json={
            "doctor_id": seeded["doctor_aa"],
            "clinic_type_id": clinic_type["id"],
            "target_count": "3.2",
        })
        assert resp.status_code == 200, resp.text
        body = resp.json()
        assert body["doctor_code"] == "AA"
        assert body["clinic_type_name"] == "Dragon"
        assert body["raw_count"] == 0
        assert body["adjustment"] == "3.2"
        assert body["id"] is not None

        row = db_session.query(ClinicCounter).one()
        assert row.raw_count == 0
        assert row.adjustment == Decimal("3.2")

    def test_target_above_raw_stores_a_positive_delta(
        self, client, db_session, seeded
    ):
        clinic_type = make_clinic_type_via_api(client, seeded)
        db_session.add(ClinicCounter(
            doctor_id=seeded["doctor_aa"],
            clinic_type_id=clinic_type["id"],
            raw_count=7,
            adjustment=Decimal("1.0"),
        ))
        db_session.commit()

        resp = client.put(CLINIC_ADJUSTMENT_URL, json={
            "doctor_id": seeded["doctor_aa"],
            "clinic_type_id": clinic_type["id"],
            "target_count": "9.5",
        })
        assert resp.status_code == 200, resp.text
        # Raw is untouched; 9.5 - 7 is stored.
        assert resp.json()["raw_count"] == 7
        assert resp.json()["adjustment"] == "2.5"

        db_session.expire_all()
        row = db_session.query(ClinicCounter).one()
        assert row.raw_count == 7
        assert row.adjustment == Decimal("2.5")

    def test_target_below_raw_stores_a_negative_delta(
        self, client, db_session, seeded
    ):
        """The mirror case -- "this doctor was over-allocated last quarter" --
        is legal and deliberately unconstrained."""
        clinic_type = make_clinic_type_via_api(client, seeded)
        db_session.add(ClinicCounter(
            doctor_id=seeded["doctor_aa"],
            clinic_type_id=clinic_type["id"],
            raw_count=7,
        ))
        db_session.commit()

        resp = client.put(CLINIC_ADJUSTMENT_URL, json={
            "doctor_id": seeded["doctor_aa"],
            "clinic_type_id": clinic_type["id"],
            "target_count": "4.5",
        })
        assert resp.status_code == 200, resp.text
        assert resp.json()["adjustment"] == "-2.5"

        db_session.expire_all()
        assert db_session.query(ClinicCounter).one().adjustment == Decimal("-2.5")

    def test_target_equal_to_raw_zeroes_the_delta_and_keeps_the_row(
        self, client, db_session, seeded
    ):
        """Unlike the duty adjustment's own table, this row also carries a raw
        count, so "no deviation" is not "nothing to store"."""
        clinic_type = make_clinic_type_via_api(client, seeded)
        db_session.add(ClinicCounter(
            doctor_id=seeded["doctor_aa"],
            clinic_type_id=clinic_type["id"],
            raw_count=4,
            adjustment=Decimal("3.0"),
        ))
        db_session.commit()

        resp = client.put(CLINIC_ADJUSTMENT_URL, json={
            "doctor_id": seeded["doctor_aa"],
            "clinic_type_id": clinic_type["id"],
            "target_count": "4",
        })
        assert resp.status_code == 200, resp.text
        assert resp.json()["adjustment"] == "0.0"
        assert db_session.query(ClinicCounter).count() == 1

    def test_delta_is_rederived_against_a_changed_raw_count(
        self, client, db_session, seeded
    ):
        """The whole justification for deriving server-side: a generation
        landing between page load and save must not change what the admin gets.
        The same target against a larger raw count means a smaller credit."""
        clinic_type = make_clinic_type_via_api(client, seeded)
        client.put(CLINIC_ADJUSTMENT_URL, json={
            "doctor_id": seeded["doctor_aa"],
            "clinic_type_id": clinic_type["id"],
            "target_count": "10.0",
        })
        db_session.expire_all()
        row = db_session.query(ClinicCounter).one()
        assert row.adjustment == Decimal("10.0")

        row.raw_count = 6
        db_session.commit()

        resp = client.put(CLINIC_ADJUSTMENT_URL, json={
            "doctor_id": seeded["doctor_aa"],
            "clinic_type_id": clinic_type["id"],
            "target_count": "10.0",
        })
        assert resp.status_code == 200, resp.text
        assert resp.json()["adjustment"] == "4.0"

        db_session.expire_all()
        assert db_session.query(ClinicCounter).one().adjustment == Decimal("4.0")

    def test_unknown_doctor_404(self, client, seeded):
        clinic_type = make_clinic_type_via_api(client, seeded)
        resp = client.put(CLINIC_ADJUSTMENT_URL, json={
            "doctor_id": 999999,
            "clinic_type_id": clinic_type["id"],
            "target_count": "1.0",
        })
        assert resp.status_code == 404

    def test_unknown_clinic_type_404(self, client, seeded):
        resp = client.put(CLINIC_ADJUSTMENT_URL, json={
            "doctor_id": seeded["doctor_aa"],
            "clinic_type_id": 999999,
            "target_count": "1.0",
        })
        assert resp.status_code == 404

    def test_two_decimal_places_422(self, client, seeded):
        clinic_type = make_clinic_type_via_api(client, seeded)
        resp = client.put(CLINIC_ADJUSTMENT_URL, json={
            "doctor_id": seeded["doctor_aa"],
            "clinic_type_id": clinic_type["id"],
            "target_count": "3.25",
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

        resp = client.put(CLINIC_ADJUSTMENT_URL, json={
            "doctor_id": trainee.id,
            "clinic_type_id": clinic_type["id"],
            "target_count": "2.0",
        })
        assert resp.status_code == 200, resp.text
        assert resp.json()["doctor_code"] == "TT"


class TestSystemAdjustment:
    def _counter_id(self, db_session, doctor_id):
        return db_session.query(SystemCounter).filter_by(
            doctor_id=doctor_id, counter_type=SystemCounterType.ROOM_MOVE
        ).one().id

    def test_list_carries_the_adjustment(self, client, db_session, seeded):
        counter_id = self._counter_id(db_session, seeded["doctor_bb"])
        db_session.get(SystemCounter, counter_id).adjustment = Decimal("1.5")
        db_session.commit()

        listed = client.get("/api/v1/counters/system").json()
        row = next(c for c in listed if c["id"] == counter_id)
        assert row["adjustment"] == "1.5"
        assert all(
            c["adjustment"] == "0.0" for c in listed if c["id"] != counter_id
        )

    def test_target_above_raw_stores_a_positive_delta(
        self, client, db_session, seeded
    ):
        counter_id = self._counter_id(db_session, seeded["doctor_aa"])
        db_session.get(SystemCounter, counter_id).raw_count = 6
        db_session.commit()

        resp = client.put(
            f"/api/v1/counters/system/{counter_id}/adjustment",
            json={"target_count": "8.5"},
        )
        assert resp.status_code == 200, resp.text
        body = resp.json()
        assert body["id"] == counter_id
        assert body["raw_count"] == 6
        assert body["adjustment"] == "2.5"

        db_session.expire_all()
        assert db_session.get(SystemCounter, counter_id).adjustment == Decimal("2.5")

    def test_target_below_raw_stores_a_negative_delta(
        self, client, db_session, seeded
    ):
        counter_id = self._counter_id(db_session, seeded["doctor_aa"])
        db_session.get(SystemCounter, counter_id).raw_count = 6
        db_session.commit()

        resp = client.put(
            f"/api/v1/counters/system/{counter_id}/adjustment",
            json={"target_count": "3.0"},
        )
        assert resp.status_code == 200, resp.text
        assert resp.json()["adjustment"] == "-3.0"

        db_session.expire_all()
        assert db_session.get(SystemCounter, counter_id).adjustment == Decimal("-3.0")

    def test_target_equal_to_raw_zeroes_the_delta(self, client, db_session, seeded):
        counter_id = self._counter_id(db_session, seeded["doctor_aa"])
        counter = db_session.get(SystemCounter, counter_id)
        counter.raw_count = 6
        counter.adjustment = Decimal("2.0")
        db_session.commit()

        resp = client.put(
            f"/api/v1/counters/system/{counter_id}/adjustment",
            json={"target_count": "6"},
        )
        assert resp.status_code == 200, resp.text
        assert resp.json()["adjustment"] == "0.0"

        db_session.expire_all()
        assert db_session.get(SystemCounter, counter_id).adjustment == Decimal("0.0")

    def test_delta_is_rederived_against_a_changed_raw_count(
        self, client, db_session, seeded
    ):
        """Same target, larger raw count, smaller stored credit -- decision 2's
        justification, on the system endpoint."""
        counter_id = self._counter_id(db_session, seeded["doctor_aa"])
        url = f"/api/v1/counters/system/{counter_id}/adjustment"

        client.put(url, json={"target_count": "10.0"})
        db_session.expire_all()
        assert db_session.get(SystemCounter, counter_id).adjustment == Decimal("10.0")

        db_session.get(SystemCounter, counter_id).raw_count = 6
        db_session.commit()

        resp = client.put(url, json={"target_count": "10.0"})
        assert resp.status_code == 200, resp.text
        assert resp.json()["adjustment"] == "4.0"

        db_session.expire_all()
        assert db_session.get(SystemCounter, counter_id).adjustment == Decimal("4.0")

    def test_unknown_id_404(self, client, seeded):
        resp = client.put(
            "/api/v1/counters/system/999999/adjustment", json={"target_count": "1.0"}
        )
        assert resp.status_code == 404

    def test_two_decimal_places_422(self, client, db_session, seeded):
        counter_id = self._counter_id(db_session, seeded["doctor_aa"])
        resp = client.put(
            f"/api/v1/counters/system/{counter_id}/adjustment",
            json={"target_count": "2.55"},
        )
        assert resp.status_code == 422


class TestResetClearsTheAdjustment:
    """After a reset every doctor is level at zero by definition, so a
    surviving adjustment would re-introduce the skew it was created to
    remove."""

    def test_single_clinic_reset(self, client, db_session, seeded):
        clinic_type = make_clinic_type_via_api(client, seeded)
        counter = ClinicCounter(
            doctor_id=seeded["doctor_aa"],
            clinic_type_id=clinic_type["id"],
            raw_count=4,
            adjustment=Decimal("3.0"),
        )
        db_session.add(counter)
        db_session.commit()

        resp = client.post(f"/api/v1/counters/clinic/{counter.id}/reset")
        assert resp.status_code == 200, resp.text
        assert resp.json()["adjustment"] == "0.0"

        db_session.expire_all()
        assert db_session.get(ClinicCounter, counter.id).adjustment == Decimal("0.0")

    def test_single_system_reset(self, client, db_session, seeded):
        counter = db_session.query(SystemCounter).filter_by(
            doctor_id=seeded["doctor_bb"], counter_type=SystemCounterType.SUPERVISION
        ).one()
        counter.raw_count = 3
        counter.adjustment = Decimal("2.0")
        db_session.commit()

        resp = client.post(f"/api/v1/counters/system/{counter.id}/reset")
        assert resp.status_code == 200, resp.text
        assert resp.json()["adjustment"] == "0.0"

        db_session.expire_all()
        assert db_session.get(SystemCounter, counter.id).adjustment == Decimal("0.0")

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
                raw_count=4, adjustment=Decimal("3.0"),
            ),
            ClinicCounter(
                doctor_id=trainee.id, clinic_type_id=clinic_type["id"],
                raw_count=7, adjustment=Decimal("5.0"),
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
            assert row.adjustment == Decimal("0.0")

    def test_system_reset_all(self, client, db_session, seeded):
        for counter in db_session.query(SystemCounter).all():
            counter.raw_count = 9
            counter.adjustment = Decimal("4.0")
        db_session.commit()

        assert client.post("/api/v1/counters/system/reset-all").status_code == 204

        db_session.expire_all()
        for counter in db_session.query(SystemCounter).all():
            assert counter.raw_count == 0
            assert counter.adjustment == Decimal("0.0")
