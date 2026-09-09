"""Duty opening balance endpoint (counter opening balances plan, Task 3).

Covers `PUT /duty/opening-balance` and the `opening_balance` field
`GET /duty/counts` now returns, including the year resolution rule: the
balance is taken from the year of `from_date`, and is zero when `from_date`
is absent.

Like the counter balances, `opening_balance` crosses the wire as a JSON
string (it is a Decimal), so the assertions compare against strings.
"""
import datetime
from decimal import Decimal

from app.models import DutyAssignment, DutyOpeningBalance
from app.models.enums import DutyType, Period

BALANCE_URL = "/api/v1/duty/opening-balance"
MONDAY = datetime.date(2026, 1, 5)


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
        assert {code: row["opening_balance"] for code, row in rows.items()} == {
            "AA": "0.0", "BB": "0.0"
        }

    def test_reports_the_stored_balance_for_that_year(
        self, client, db_session, seeded
    ):
        db_session.add(DutyOpeningBalance(
            doctor_id=seeded["doctor_aa"], year=2026, sessions=Decimal("3.2"),
        ))
        db_session.commit()

        assert _counts(client)["AA"]["opening_balance"] == "3.2"
        assert _counts(client)["BB"]["opening_balance"] == "0.0"

    def test_other_years_are_unaffected(self, client, db_session, seeded):
        db_session.add(DutyOpeningBalance(
            doctor_id=seeded["doctor_aa"], year=2026, sessions=Decimal("3.2"),
        ))
        db_session.commit()

        rows = _counts(client, from_date="2027-01-01", to_date="2027-12-31")
        assert rows["AA"]["opening_balance"] == "0.0"

    def test_year_comes_from_from_date_when_the_range_straddles(
        self, client, db_session, seeded
    ):
        """Documented rule, not an accident: the balance of the year the range
        starts in, not a sum across years. The Duty page always asks for a
        whole calendar year, so this case does not arise in practice."""
        db_session.add_all([
            DutyOpeningBalance(
                doctor_id=seeded["doctor_aa"], year=2026, sessions=Decimal("3.0"),
            ),
            DutyOpeningBalance(
                doctor_id=seeded["doctor_aa"], year=2027, sessions=Decimal("9.0"),
            ),
        ])
        db_session.commit()

        rows = _counts(client, from_date="2026-07-01", to_date="2027-06-30")
        assert rows["AA"]["opening_balance"] == "3.0"

    def test_no_from_date_means_zero(self, client, db_session, seeded):
        db_session.add(DutyOpeningBalance(
            doctor_id=seeded["doctor_aa"], year=2026, sessions=Decimal("3.2"),
        ))
        db_session.commit()

        rows = _counts(client, from_date=None, to_date=None)
        assert rows["AA"]["opening_balance"] == "0.0"

    def test_raw_count_still_reported(self, client, db_session, seeded):
        db_session.add(DutyAssignment(
            date=MONDAY, period=Period.AM,
            doctor_id=seeded["doctor_aa"], duty_type=DutyType.PRIMARY,
        ))
        db_session.add(DutyOpeningBalance(
            doctor_id=seeded["doctor_aa"], year=2026, sessions=Decimal("3.2"),
        ))
        db_session.commit()

        row = _counts(client)["AA"]
        assert row["raw_count"] == 1
        assert row["opening_balance"] == "3.2"


class TestUpsert:
    def test_creates_a_row(self, client, db_session, seeded):
        resp = client.put(BALANCE_URL, json={
            "doctor_id": seeded["doctor_aa"], "year": 2026, "sessions": "3.2",
            "notes": "joined 2026-03-01, credited at the group average",
        })
        assert resp.status_code == 200, resp.text
        body = resp.json()
        assert body["doctor_code"] == "AA"
        assert body["raw_count"] == 0
        assert body["opening_balance"] == "3.2"

        row = db_session.query(DutyOpeningBalance).one()
        assert row.year == 2026
        assert row.sessions == Decimal("3.2")
        assert row.notes.startswith("joined")

    def test_updates_an_existing_row(self, client, db_session, seeded):
        db_session.add(DutyOpeningBalance(
            doctor_id=seeded["doctor_aa"], year=2026, sessions=Decimal("3.2"),
            notes="first guess",
        ))
        db_session.commit()

        resp = client.put(BALANCE_URL, json={
            "doctor_id": seeded["doctor_aa"], "year": 2026, "sessions": "-1.5",
        })
        assert resp.status_code == 200, resp.text
        assert resp.json()["opening_balance"] == "-1.5"

        db_session.expire_all()
        row = db_session.query(DutyOpeningBalance).one()
        assert row.sessions == Decimal("-1.5")
        assert row.notes is None  # full replace, not a patch

    def test_zero_deletes_the_row(self, client, db_session, seeded):
        db_session.add(DutyOpeningBalance(
            doctor_id=seeded["doctor_aa"], year=2026, sessions=Decimal("3.2"),
        ))
        db_session.commit()

        resp = client.put(BALANCE_URL, json={
            "doctor_id": seeded["doctor_aa"], "year": 2026, "sessions": "0",
        })
        assert resp.status_code == 200, resp.text
        assert resp.json()["opening_balance"] == "0.0"
        assert db_session.query(DutyOpeningBalance).count() == 0

    def test_zero_on_a_doctor_with_no_row_is_a_no_op(self, client, db_session, seeded):
        resp = client.put(BALANCE_URL, json={
            "doctor_id": seeded["doctor_bb"], "year": 2026, "sessions": "0.0",
        })
        assert resp.status_code == 200, resp.text
        assert db_session.query(DutyOpeningBalance).count() == 0

    def test_response_carries_the_year_count(self, client, db_session, seeded):
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

        resp = client.put(BALANCE_URL, json={
            "doctor_id": seeded["doctor_aa"], "year": 2026, "sessions": "2.0",
        })
        assert resp.status_code == 200, resp.text
        assert resp.json()["raw_count"] == 1

    def test_is_reflected_by_the_counts_endpoint(self, client, seeded):
        client.put(BALANCE_URL, json={
            "doctor_id": seeded["doctor_aa"], "year": 2026, "sessions": "3.2",
        })
        assert _counts(client)["AA"]["opening_balance"] == "3.2"

    def test_unknown_doctor_404(self, client, seeded):
        resp = client.put(BALANCE_URL, json={
            "doctor_id": 999999, "year": 2026, "sessions": "1.0",
        })
        assert resp.status_code == 404

    def test_two_decimal_places_422(self, client, seeded):
        resp = client.put(BALANCE_URL, json={
            "doctor_id": seeded["doctor_aa"], "year": 2026, "sessions": "3.25",
        })
        assert resp.status_code == 422

    def test_out_of_range_year_422(self, client, seeded):
        resp = client.put(BALANCE_URL, json={
            "doctor_id": seeded["doctor_aa"], "year": 202, "sessions": "1.0",
        })
        assert resp.status_code == 422
