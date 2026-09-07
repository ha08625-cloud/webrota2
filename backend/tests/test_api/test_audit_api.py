"""GET /audit tests: filtering, paging, ordering and the manager gate.

Rows are seeded directly through `db_session` rather than by making real
requests, so a test controls its own timestamps, users and statuses. That
is safe here because the endpoint under test is a GET and the middleware
writes nothing for GETs -- a test that made writes to build its fixture
would find the middleware's own rows mixed into the results.

Timestamps are stored UTC-aware but SQLite does not round-trip tzinfo, so
both the seeded values and the `since`/`until` query values are UTC
wall-clock and read back naive. Assertions compare on ids, not datetimes,
wherever they can.

The gate tests each take exactly one client fixture: `client_with_permissions` and
its wrappers write to the single `app.dependency_overrides` dict, so two in
one test would give both the same identity (see conftest.py).
"""
import datetime

import pytest

from app.api.main import API_PREFIX
from app.models import AuditLogEntry, User
from app.models.enums import AccessLevel

AUDIT = f"{API_PREFIX}/audit"

BASE = datetime.datetime(2026, 3, 1, 9, 0, 0, tzinfo=datetime.timezone.utc)


def _add(db_session, *, minutes=0, at=None, method="POST", path="/api/v1/doctors",
         status_code=200, user_id=None, **kwargs):
    entry = AuditLogEntry(
        at=at if at is not None else BASE + datetime.timedelta(minutes=minutes),
        method=method,
        path=path,
        status_code=status_code,
        user_id=user_id,
        **kwargs,
    )
    db_session.add(entry)
    db_session.commit()
    return entry


@pytest.fixture
def rows(db_session):
    """Four rows, ten minutes apart, spanning the filter surface."""
    return [
        _add(db_session, minutes=0, method="POST", path="/api/v1/doctors",
             status_code=201, user_email="a@example.com"),
        _add(db_session, minutes=10, method="PATCH",
             path="/api/v1/rota/12/sessions/45", status_code=200),
        _add(db_session, minutes=20, method="PATCH", path="/api/v1/rota/120",
             status_code=422, outcome_detail="body.doctor_id: field required"),
        _add(db_session, minutes=30, method="DELETE", path="/api/v1/leave/7",
             status_code=403),
    ]


def _ids(resp):
    return [item["id"] for item in resp.json()["items"]]


def test_lists_newest_first_with_total(client, rows):
    resp = client.get(AUDIT)
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["total"] == 4
    assert _ids(resp) == [r.id for r in reversed(rows)]


def test_entry_shape_round_trips_every_column(client, db_session):
    entry = _add(
        db_session,
        method="PATCH",
        path="/api/v1/doctors/3",
        status_code=200,
        user_id=None,
        user_email="manager@example.com",
        user_access_level="manager",
        route="/doctors/{doctor_id}",
        path_params={"doctor_id": "3"},
        request_body={"sessions_per_week": 8, "password": "[redacted]"},
        outcome_detail=None,
        duration_ms=12,
        client_ip="10.0.0.1",
    )

    item = client.get(AUDIT).json()["items"][0]
    assert item["id"] == entry.id
    assert item["user_email"] == "manager@example.com"
    assert item["user_access_level"] == "manager"
    assert item["route"] == "/doctors/{doctor_id}"
    assert item["path_params"] == {"doctor_id": "3"}
    assert item["request_body"] == {"sessions_per_week": 8, "password": "[redacted]"}
    assert item["duration_ms"] == 12
    assert item["client_ip"] == "10.0.0.1"


def test_filter_by_method_is_case_insensitive(client, rows):
    resp = client.get(AUDIT, params={"method": "patch"})
    assert resp.json()["total"] == 2
    assert _ids(resp) == [rows[2].id, rows[1].id]


def test_filter_by_path_substring(client, rows):
    resp = client.get(AUDIT, params={"path_contains": "/rota/12/"})
    assert _ids(resp) == [rows[1].id]


def test_path_substring_has_no_word_boundaries(client, rows):
    """Documented behaviour, not a bug: /rota/12 also matches /rota/120."""
    resp = client.get(AUDIT, params={"path_contains": "/rota/12"})
    assert set(_ids(resp)) == {rows[1].id, rows[2].id}


def test_percent_in_path_filter_is_literal(client, db_session, rows):
    literal = _add(db_session, minutes=40, path="/api/v1/doctors/100%25")
    resp = client.get(AUDIT, params={"path_contains": "%"})
    # Without autoescape this would be a wildcard and match all five rows.
    assert _ids(resp) == [literal.id]


def test_underscore_in_path_filter_is_literal(client, db_session, rows):
    literal = _add(db_session, minutes=40, path="/api/v1/school_holidays")
    resp = client.get(AUDIT, params={"path_contains": "l_h"})
    assert _ids(resp) == [literal.id]


def test_filter_by_status_range(client, rows):
    resp = client.get(AUDIT, params={"status_min": 400, "status_max": 499})
    assert set(_ids(resp)) == {rows[2].id, rows[3].id}

    resp = client.get(AUDIT, params={"status_max": 299})
    assert set(_ids(resp)) == {rows[0].id, rows[1].id}

    # Both bounds are inclusive.
    resp = client.get(AUDIT, params={"status_min": 422, "status_max": 422})
    assert _ids(resp) == [rows[2].id]


def test_filter_by_user_id(client, db_session, rows):
    # user_id carries a real FK, so the row has to exist.
    user = User(
        email="manager@example.com",
        name="Seeded User",
        password_hash="x",
        active=True,
        access_level=AccessLevel.MANAGER,
        created_at=datetime.datetime.now(datetime.timezone.utc),
    )
    db_session.add(user)
    db_session.commit()

    mine = _add(db_session, minutes=40, user_id=user.id)
    resp = client.get(AUDIT, params={"user_id": user.id})
    assert _ids(resp) == [mine.id]
    assert resp.json()["total"] == 1


def test_filter_by_since_and_until(client, rows):
    # Naive UTC, matching how SQLite reads the column back.
    resp = client.get(AUDIT, params={"since": "2026-03-01T09:10:00"})
    assert set(_ids(resp)) == {rows[1].id, rows[2].id, rows[3].id}

    resp = client.get(AUDIT, params={"until": "2026-03-01T09:20:00"})
    assert set(_ids(resp)) == {rows[0].id, rows[1].id, rows[2].id}

    resp = client.get(AUDIT, params={
        "since": "2026-03-01T09:10:00", "until": "2026-03-01T09:20:00",
    })
    assert set(_ids(resp)) == {rows[1].id, rows[2].id}


def test_filters_combine(client, rows):
    resp = client.get(AUDIT, params={
        "method": "PATCH",
        "path_contains": "/rota/",
        "status_min": 400,
    })
    assert _ids(resp) == [rows[2].id]
    assert resp.json()["total"] == 1


def test_total_reflects_the_filters_not_the_page(client, rows):
    resp = client.get(AUDIT, params={"limit": 1})
    assert resp.json()["total"] == 4
    assert len(resp.json()["items"]) == 1

    resp = client.get(AUDIT, params={"limit": 1, "method": "PATCH"})
    assert resp.json()["total"] == 2
    assert len(resp.json()["items"]) == 1


def test_paging_returns_disjoint_pages_covering_everything(client, rows):
    first = client.get(AUDIT, params={"limit": 2, "offset": 0})
    second = client.get(AUDIT, params={"limit": 2, "offset": 2})
    assert _ids(first) == [rows[3].id, rows[2].id]
    assert _ids(second) == [rows[1].id, rows[0].id]
    assert not set(_ids(first)) & set(_ids(second))

    beyond = client.get(AUDIT, params={"limit": 2, "offset": 4})
    assert beyond.json()["items"] == []
    assert beyond.json()["total"] == 4


def test_ordering_breaks_timestamp_ties_by_id(client, db_session):
    """Identical timestamps must still page deterministically."""
    same = BASE
    a = _add(db_session, at=same)
    b = _add(db_session, at=same)
    c = _add(db_session, at=same)

    resp = client.get(AUDIT)
    assert _ids(resp) == [c.id, b.id, a.id]

    # And the tiebreak holds across a page boundary: no repeats, no gaps.
    page_one = client.get(AUDIT, params={"limit": 2, "offset": 0})
    page_two = client.get(AUDIT, params={"limit": 2, "offset": 2})
    assert _ids(page_one) + _ids(page_two) == [c.id, b.id, a.id]


@pytest.mark.parametrize("params", [
    {"limit": 0}, {"limit": 201}, {"offset": -1},
])
def test_paging_bounds_are_enforced(client, params):
    assert client.get(AUDIT, params=params).status_code == 422


# ---------------------------------------------------------------------------
# Access control: `user_admin` only, including the read
# ---------------------------------------------------------------------------


def test_manager_can_read(manager_client):
    assert manager_client.get(AUDIT).status_code == 200


def test_a_rota_admin_cannot_read(rota_admin_client):
    """Unlike the rota sections, write access to them is not enough here --
    this router sits in the `user_admin` area, and that permission being a
    boolean is what covers its GETs too."""
    assert rota_admin_client.get(AUDIT).status_code == 403


def test_nurse_cannot_read(readonly_client):
    assert readonly_client.get(AUDIT).status_code == 403


def test_unauthenticated_cannot_read(client_no_auth):
    assert client_no_auth.get(AUDIT).status_code == 401
