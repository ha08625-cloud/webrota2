"""Duty adjustment endpoint (counter adjustments plan, Task 2).

Covers `PUT /duty/adjustment` and the `adjustment` field `GET /duty/counts`
returns, including the year resolution rule: the adjustment is taken from the
year of `from_date`, and is zero when `from_date` is absent.

The upsert takes a **target effective total** for the calendar year
(`target_count`), not a credit: the server derives
`adjustment = target_count - raw_count` against the 1 Jan-31 Dec count, and a
derived zero deletes the row.

Like the counter adjustments, `adjustment` crosses the wire as a JSON
string (it is a Decimal), so the assertions compare against strings.
"""
import datetime
from decimal import Decimal

from app.models import DutyAssignment, DutyCounterAdjustment
from app.models.enums import DutyType, Period

ADJUSTMENT_URL = "/api/v1/duty/adjustment"
MONDAY = datetime.date(2026, 1, 5)


def _assign(db_session, doctor_id, first_date, days):
    """`days` consecutive AM primary duties from `first_date`, committed."""
    db_session.add_all([
        DutyAssignment(
            date=first_date + datetime.timedelta(days=offset),
            period=Period.AM,
            doctor_id=doctor_id,
            duty_type=DutyType.PRIMARY,
        )
        for offset in range(days)
    ])
    db_session.commit()


def _counts(client, from_date="2026-01-01", to_date="2026-12-31"):
    params = []
    if from_date is not None:
        params.append(f"from_date={from_date}")
    if to_date is not None:
        params.append(f"to_date={to_date}")
    query = f"?{'&'.join(params)}" if params else ""
    resp = client.get(f"/api/v1/duty/counts{query}")
    assert resp.status_code == 200, resp.text
    return {row["doctor_code"]: row for row in resp.json()}


class TestCounts:
    def test_defaults_to_zero(self, client, seeded):
        rows = _counts(client)
        assert {code: row["adjustment"] for code, row in rows.items()} == {
            "AA": "0.0", "BB": "0.0"
        }

    def test_reports_the_stored_adjustment_for_that_year(
        self, client, db_session, seeded
    ):
        db_session.add(DutyCounterAdjustment(
            doctor_id=seeded["doctor_aa"], year=2026, adjustment=Decimal("3.2"),
        ))
        db_session.commit()

        assert _counts(client)["AA"]["adjustment"] == "3.2"
        assert _counts(client)["BB"]["adjustment"] == "0.0"

    def test_other_years_are_unaffected(self, client, db_session, seeded):
        db_session.add(DutyCounterAdjustment(
            doctor_id=seeded["doctor_aa"], year=2026, adjustment=Decimal("3.2"),
        ))
        db_session.commit()

        rows = _counts(client, from_date="2027-01-01", to_date="2027-12-31")
        assert rows["AA"]["adjustment"] == "0.0"

    def test_year_comes_from_from_date_when_the_range_straddles(
        self, client, db_session, seeded
    ):
        """Documented rule, not an accident: the adjustment of the year the range
        starts in, not a sum across years. The Duty page always asks for a
        whole calendar year, so this case does not arise in practice."""
        db_session.add_all([
            DutyCounterAdjustment(
                doctor_id=seeded["doctor_aa"], year=2026, adjustment=Decimal("3.0"),
            ),
            DutyCounterAdjustment(
                doctor_id=seeded["doctor_aa"], year=2027, adjustment=Decimal("9.0"),
            ),
        ])
        db_session.commit()

        rows = _counts(client, from_date="2026-07-01", to_date="2027-06-30")
        assert rows["AA"]["adjustment"] == "3.0"

    def test_no_from_date_means_zero(self, client, db_session, seeded):
        db_session.add(DutyCounterAdjustment(
            doctor_id=seeded["doctor_aa"], year=2026, adjustment=Decimal("3.2"),
        ))
        db_session.commit()

        rows = _counts(client, from_date=None, to_date=None)
        assert rows["AA"]["adjustment"] == "0.0"

    def test_raw_count_still_reported(self, client, db_session, seeded):
        db_session.add(DutyAssignment(
            date=MONDAY, period=Period.AM,
            doctor_id=seeded["doctor_aa"], duty_type=DutyType.PRIMARY,
        ))
        db_session.add(DutyCounterAdjustment(
            doctor_id=seeded["doctor_aa"], year=2026, adjustment=Decimal("3.2"),
        ))
        db_session.commit()

        row = _counts(client)["AA"]
        assert row["raw_count"] == 1
        assert row["adjustment"] == "3.2"


class TestUpsert:
    def test_creates_a_row_from_the_target(self, client, db_session, seeded):
        """No duty assignments in 2026, so the raw count is zero and the whole
        target becomes the adjustment."""
        resp = client.put(ADJUSTMENT_URL, json={
            "doctor_id": seeded["doctor_aa"], "year": 2026, "target_count": "3.2",
        })
        assert resp.status_code == 200, resp.text
        body = resp.json()
        assert body["doctor_code"] == "AA"
        assert body["raw_count"] == 0
        assert body["adjustment"] == "3.2"

        row = db_session.query(DutyCounterAdjustment).one()
        assert row.year == 2026
        assert row.adjustment == Decimal("3.2")

    def test_target_above_raw_stores_a_positive_delta(
        self, client, db_session, seeded
    ):
        _assign(db_session, seeded["doctor_aa"], MONDAY, days=3)

        resp = client.put(ADJUSTMENT_URL, json={
            "doctor_id": seeded["doctor_aa"], "year": 2026, "target_count": "5.5",
        })
        assert resp.status_code == 200, resp.text
        assert resp.json()["raw_count"] == 3
        assert resp.json()["adjustment"] == "2.5"

        assert db_session.query(DutyCounterAdjustment).one().adjustment == Decimal("2.5")

    def test_target_below_raw_stores_a_negative_delta(
        self, client, db_session, seeded
    ):
        """The mirror case -- a doctor over-allocated earlier in the year -- is
        legal and deliberately unconstrained."""
        _assign(db_session, seeded["doctor_aa"], MONDAY, days=3)

        resp = client.put(ADJUSTMENT_URL, json={
            "doctor_id": seeded["doctor_aa"], "year": 2026, "target_count": "1.0",
        })
        assert resp.status_code == 200, resp.text
        assert resp.json()["adjustment"] == "-2.0"

        assert db_session.query(DutyCounterAdjustment).one().adjustment == Decimal("-2.0")

    def test_updates_an_existing_row(self, client, db_session, seeded):
        db_session.add(DutyCounterAdjustment(
            doctor_id=seeded["doctor_aa"], year=2026, adjustment=Decimal("3.2"),
        ))
        _assign(db_session, seeded["doctor_aa"], MONDAY, days=2)

        resp = client.put(ADJUSTMENT_URL, json={
            "doctor_id": seeded["doctor_aa"], "year": 2026, "target_count": "0.5",
        })
        assert resp.status_code == 200, resp.text
        assert resp.json()["adjustment"] == "-1.5"

        db_session.expire_all()
        row = db_session.query(DutyCounterAdjustment).one()
        assert row.adjustment == Decimal("-1.5")

    def test_target_equal_to_raw_deletes_the_row(self, client, db_session, seeded):
        """A derived zero is "no deviation", and this table holds only real
        deviations -- so the row goes, rather than storing a zero."""
        db_session.add(DutyCounterAdjustment(
            doctor_id=seeded["doctor_aa"], year=2026, adjustment=Decimal("3.2"),
        ))
        _assign(db_session, seeded["doctor_aa"], MONDAY, days=2)

        resp = client.put(ADJUSTMENT_URL, json={
            "doctor_id": seeded["doctor_aa"], "year": 2026, "target_count": "2",
        })
        assert resp.status_code == 200, resp.text
        assert resp.json()["adjustment"] == "0.0"
        assert db_session.query(DutyCounterAdjustment).count() == 0

    def test_zero_target_on_a_doctor_with_no_duties_is_a_no_op(
        self, client, db_session, seeded
    ):
        resp = client.put(ADJUSTMENT_URL, json={
            "doctor_id": seeded["doctor_bb"], "year": 2026, "target_count": "0.0",
        })
        assert resp.status_code == 200, resp.text
        assert db_session.query(DutyCounterAdjustment).count() == 0

    def test_delta_is_rederived_against_a_changed_raw_count(
        self, client, db_session, seeded
    ):
        """Decision 2's justification: duties assigned between page load and
        save shrink the credit the same target implies, rather than the admin
        silently getting a total they did not ask for."""
        client.put(ADJUSTMENT_URL, json={
            "doctor_id": seeded["doctor_aa"], "year": 2026, "target_count": "10.0",
        })
        assert db_session.query(DutyCounterAdjustment).one().adjustment == Decimal("10.0")

        _assign(db_session, seeded["doctor_aa"], MONDAY, days=4)

        resp = client.put(ADJUSTMENT_URL, json={
            "doctor_id": seeded["doctor_aa"], "year": 2026, "target_count": "10.0",
        })
        assert resp.status_code == 200, resp.text
        assert resp.json()["raw_count"] == 4
        assert resp.json()["adjustment"] == "6.0"

        db_session.expire_all()
        assert db_session.query(DutyCounterAdjustment).one().adjustment == Decimal("6.0")

    def test_the_delta_is_derived_against_the_whole_year_only(
        self, client, db_session, seeded
    ):
        """The count behind the derivation is 1 Jan to 31 Dec of `year`, which
        is why the caller must send a whole-year total -- duties outside the
        year do not move it."""
        db_session.add_all([
            DutyAssignment(
                date=MONDAY, period=Period.AM,
                doctor_id=seeded["doctor_aa"], duty_type=DutyType.PRIMARY,
            ),
            # Outside 2026, so it must not be counted.
            DutyAssignment(
                date=datetime.date(2027, 1, 4), period=Period.AM,
                doctor_id=seeded["doctor_aa"], duty_type=DutyType.PRIMARY,
            ),
        ])
        db_session.commit()

        resp = client.put(ADJUSTMENT_URL, json={
            "doctor_id": seeded["doctor_aa"], "year": 2026, "target_count": "3.0",
        })
        assert resp.status_code == 200, resp.text
        assert resp.json()["raw_count"] == 1
        assert resp.json()["adjustment"] == "2.0"

    def test_is_reflected_by_the_counts_endpoint(self, client, seeded):
        client.put(ADJUSTMENT_URL, json={
            "doctor_id": seeded["doctor_aa"], "year": 2026, "target_count": "3.2",
        })
        assert _counts(client)["AA"]["adjustment"] == "3.2"

    def test_unknown_doctor_404(self, client, seeded):
        resp = client.put(ADJUSTMENT_URL, json={
            "doctor_id": 999999, "year": 2026, "target_count": "1.0",
        })
        assert resp.status_code == 404

    def test_two_decimal_places_422(self, client, seeded):
        resp = client.put(ADJUSTMENT_URL, json={
            "doctor_id": seeded["doctor_aa"], "year": 2026, "target_count": "3.25",
        })
        assert resp.status_code == 422

    def test_out_of_range_year_422(self, client, seeded):
        resp = client.put(ADJUSTMENT_URL, json={
            "doctor_id": seeded["doctor_aa"], "year": 202, "target_count": "1.0",
        })
        assert resp.status_code == 422
