"""GET /reception/counters tests (reception counters, Task 2).

These are endpoint tests: window resolution, validation, auth and the wire
shape. The aggregation itself -- leave exclusion, hours arithmetic,
zero-filling, days_present -- is covered against the compute module in
tests/test_reception_counters.py, so only one end-to-end leave case is
repeated here, to prove the router is not filtering rows of its own.

"Today" is pinned by monkeypatching `reception_counters_router._today`
rather than by asserting against the wall clock, so the default-window test
means the same thing on a Monday as on a Friday.
"""
import datetime

import pytest

from app.api.routers import reception_counters as reception_counters_router
from app.models import ReceptionLeaveEntry, ReceptionRota, ReceptionRotaSession
from app.models.enums import ReceptionRole

from .conftest import MONDAY

COUNTERS_URL = "/api/v1/reception/counters"

# MONDAY is 2026-01-05, a Monday. WEDNESDAY sits inside the same week, so a
# window anchored to it has the same from_date and a later to_date.
WEDNESDAY = MONDAY + datetime.timedelta(days=2)


@pytest.fixture
def pin_today(monkeypatch):
    """Pin the router's notion of today. Returns a setter so a test can
    choose the anchor after the fixtures have seeded their dates."""

    def _pin(day: datetime.date):
        monkeypatch.setattr(reception_counters_router, "_today", lambda: day)

    return _pin


def _generate_day(db, date, staff_roles, first_hour=9.0):
    """One ReceptionRota on `date` with the given {staff_id: [roles]} rows,
    laid out on consecutive half-hour slots per staff member (the unique
    constraint is (rota, staff, hour), so one staff member's roles cannot
    share an hour)."""
    rota = ReceptionRota(date=date)
    db.add(rota)
    db.flush()
    for staff_id, roles in staff_roles.items():
        for i, role in enumerate(roles):
            db.add(ReceptionRotaSession(
                rota_id=rota.id,
                staff_id=staff_id,
                hour=first_hour + 0.5 * i,
                role=role,
            ))
    db.commit()
    return rota


def _row_by_code(body, code):
    return next(r for r in body["staff"] if r["staff_code"] == code)


class TestWindowResolution:
    def test_default_window_is_four_weeks_back_to_today(
        self, client, seeded_reception, pin_today
    ):
        pin_today(WEDNESDAY)
        resp = client.get(COUNTERS_URL)
        assert resp.status_code == 200, resp.text
        body = resp.json()
        # Anchored to the Monday of the current week, not to today - 28 days.
        assert body["from_date"] == (MONDAY - datetime.timedelta(weeks=4)).isoformat()
        assert body["to_date"] == WEDNESDAY.isoformat()

    def test_explicit_bounds_are_honoured(self, client, seeded_reception, pin_today):
        pin_today(WEDNESDAY)
        resp = client.get(COUNTERS_URL, params={
            "from_date": "2026-02-01", "to_date": "2026-02-28",
        })
        assert resp.status_code == 200, resp.text
        body = resp.json()
        assert body["from_date"] == "2026-02-01"
        assert body["to_date"] == "2026-02-28"

    def test_bounds_fill_independently(self, client, seeded_reception, pin_today):
        """from_date alone means "since then, up to today" -- the omitted
        bound comes from the default window and the supplied one survives."""
        pin_today(WEDNESDAY)
        resp = client.get(COUNTERS_URL, params={"from_date": "2025-12-01"})
        assert resp.status_code == 200, resp.text
        body = resp.json()
        assert body["from_date"] == "2025-12-01"
        assert body["to_date"] == WEDNESDAY.isoformat()

        resp = client.get(COUNTERS_URL, params={"to_date": "2026-01-02"})
        assert resp.status_code == 200, resp.text
        body = resp.json()
        assert body["from_date"] == (MONDAY - datetime.timedelta(weeks=4)).isoformat()
        assert body["to_date"] == "2026-01-02"

    def test_reversed_range_422(self, client, seeded_reception):
        resp = client.get(COUNTERS_URL, params={
            "from_date": "2026-02-28", "to_date": "2026-02-01",
        })
        assert resp.status_code == 422

    def test_range_with_no_rotas_is_not_an_error(self, client, seeded_reception):
        resp = client.get(COUNTERS_URL, params={
            "from_date": "2020-01-01", "to_date": "2020-01-31",
        })
        assert resp.status_code == 200, resp.text
        body = resp.json()
        assert body["days_counted"] == 0
        # Active staff still appear, zero-filled.
        assert {r["staff_code"] for r in body["staff"]} == {"RA", "RB", "RC"}
        assert all(r["hours_worked"] == 0 for r in body["staff"])

    def test_unauthenticated_401(self, client_no_auth):
        assert client_no_auth.get(COUNTERS_URL).status_code == 401


class TestResponseShape:
    def test_full_shape(self, client, seeded_reception, db_session, pin_today):
        pin_today(WEDNESDAY)
        ra = seeded_reception["staff_ra"]
        _generate_day(db_session, MONDAY, {
            ra: [
                ReceptionRole.PHONES,
                ReceptionRole.PHONES,
                ReceptionRole.LUNCH,
                ReceptionRole.NOT_WORKING,
            ],
        })

        body = client.get(COUNTERS_URL).json()
        assert body["days_counted"] == 1

        row = _row_by_code(body, "RA")
        assert row["staff_id"] == ra
        assert row["active"] is True
        assert row["days_present"] == 1
        # phones + lunch count as worked; not_working does not.
        assert row["hours_worked"] == 1.5

        # All thirteen roles present, zero-filled, keyed by the enum values.
        assert set(row["role_slots"]) == {r.value for r in ReceptionRole}
        assert row["role_slots"]["phones"] == 2
        assert row["role_slots"]["lunch"] == 1
        assert row["role_slots"]["not_working"] == 1
        assert row["role_slots"]["prescriptions"] == 0

        # No ratio is computed server-side -- that is the frontend's job,
        # and not_working has no proportion to report at all.
        assert "weighted" not in row
        assert "role_hours" not in row

    def test_inactive_staff_appear_only_with_rows(
        self, client, seeded_reception, db_session, pin_today
    ):
        pin_today(WEDNESDAY)
        rd = seeded_reception["staff_rd_inactive"]

        body = client.get(COUNTERS_URL).json()
        assert "RD" not in {r["staff_code"] for r in body["staff"]}

        _generate_day(db_session, MONDAY, {rd: [ReceptionRole.PHONES]})
        body = client.get(COUNTERS_URL).json()
        rd_row = _row_by_code(body, "RD")
        assert rd_row["active"] is False
        assert rd_row["role_slots"]["phones"] == 1

    def test_staff_ordered_by_code(
        self, client, seeded_reception, db_session, pin_today
    ):
        pin_today(WEDNESDAY)
        body = client.get(COUNTERS_URL).json()
        codes = [r["staff_code"] for r in body["staff"]]
        assert codes == sorted(codes)


class TestWindowFiltersRows:
    def test_dates_outside_the_window_are_excluded(
        self, client, seeded_reception, db_session, pin_today
    ):
        pin_today(WEDNESDAY)
        ra = seeded_reception["staff_ra"]
        _generate_day(db_session, MONDAY, {ra: [ReceptionRole.PHONES]})
        # Five weeks before the anchor Monday: outside a four-week window.
        _generate_day(
            db_session, MONDAY - datetime.timedelta(weeks=5), {ra: [ReceptionRole.ADMIN]}
        )
        # Next week: future-dated, so excluded even though it is generated.
        _generate_day(
            db_session, MONDAY + datetime.timedelta(weeks=1), {ra: [ReceptionRole.TASKS]}
        )

        body = client.get(COUNTERS_URL).json()
        assert body["days_counted"] == 1
        row = _row_by_code(body, "RA")
        assert row["role_slots"]["phones"] == 1
        assert row["role_slots"]["admin"] == 0
        assert row["role_slots"]["tasks"] == 0

    def test_leave_excluded_end_to_end(
        self, client, seeded_reception, db_session, pin_today
    ):
        """Rows on a leave date count toward neither role slots, hours, nor
        days_present -- and the rows themselves stay on the day."""
        pin_today(WEDNESDAY)
        ra = seeded_reception["staff_ra"]
        _generate_day(db_session, MONDAY, {ra: [ReceptionRole.PHONES]})
        _generate_day(db_session, WEDNESDAY, {ra: [ReceptionRole.PHONES]})

        before = _row_by_code(client.get(COUNTERS_URL).json(), "RA")
        assert (before["role_slots"]["phones"], before["days_present"]) == (2, 2)

        # Leave entered after the day was generated is picked up on the next
        # read, because the counters are derived rather than stored.
        db_session.add(ReceptionLeaveEntry(staff_id=ra, date=WEDNESDAY))
        db_session.commit()

        after = _row_by_code(client.get(COUNTERS_URL).json(), "RA")
        assert after["role_slots"]["phones"] == 1
        assert after["hours_worked"] == 0.5
        assert after["days_present"] == 1
        # The day itself still has its row, and still counts as generated.
        assert client.get(COUNTERS_URL).json()["days_counted"] == 2
