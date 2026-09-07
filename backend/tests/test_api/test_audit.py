"""Audit capture tests.

The first half exercises the middleware itself -- what gets a row, what the
row contains, and the ways it must not break the request it is auditing.
Those tests run through `client`, which overrides get_current_user with a
stub, so the enrichment hook never fires and `user_id` is null throughout.

The second half covers enrichment: the acting user, the HTTPException
detail behind a 401/403, the field-level detail behind a 422, and the user
recorded by a successful login. Every one of those tests goes through
`client_no_auth` with a directly-seeded user and a real login, and it has to
-- `client`, `client_with_permissions` and the tier fixtures all override
get_current_user, which is where the identity is recorded, so a test written
against them would assert nothing while appearing to pass. That also means
no `seeded` fixture in the second half (it depends on `client`): those tests
seed what they need through `db_session` and create the rest over the API.

The audit session factory is pointed at the per-test engine by the autouse
`_audit_to_test_engine` fixture in conftest.py, so rows written by the
middleware are readable through `db_session`.

The multipart test matters more than it looks: it proves the middleware
passes `receive` through untouched for non-JSON bodies. If it drained them,
the upload would arrive at the endpoint with an empty body and the
assertion on the 200 would fail before the null-body assertion was reached.
"""
import datetime
import io
import json

import pytest
from fastapi import APIRouter
from sqlalchemy import select

from app.api import audit
from app.api.auth_utils import hash_password
from app.api.main import API_PREFIX, app
from app.models import AuditLogEntry, User
from app.models.enums import AccessLevel
from app.models.permissions import (
    MANAGER_PRESET,
    PRESET_FOR_ACCESS_LEVEL,
    preset,
)


def _entries(db_session):
    return list(db_session.execute(
        select(AuditLogEntry).order_by(AuditLogEntry.id)
    ).scalars())


def test_patch_writes_one_row_with_templated_route_and_params(
    client, db_session, seeded
):
    doctor_id = seeded["doctor_aa"]
    resp = client.patch(
        f"{API_PREFIX}/doctors/{doctor_id}", json={"sessions_per_week": 8}
    )
    assert resp.status_code == 200, resp.text

    rows = _entries(db_session)
    assert len(rows) == 1
    row = rows[0]
    assert row.method == "PATCH"
    assert row.path == f"{API_PREFIX}/doctors/{doctor_id}"
    # Router-local, no /api/v1 prefix -- see app/api/audit.py.
    assert row.route == "/doctors/{doctor_id}"
    # The ASGI scope reports path params as strings; FastAPI coerces later.
    assert row.path_params == {"doctor_id": str(doctor_id)}
    assert row.status_code == 200
    assert row.request_body == {"sessions_per_week": 8}
    assert row.duration_ms is not None and row.duration_ms >= 0
    assert row.at is not None
    # Task 2b wires identity in; nothing records it yet.
    assert row.user_id is None


def test_get_writes_no_row(client, db_session, seeded):
    assert client.get(f"{API_PREFIX}/doctors").status_code == 200
    assert _entries(db_session) == []


def test_login_body_is_captured_with_password_redacted(
    client_no_auth, db_session
):
    db_session.add(User(
        email="manager@example.com",
        name="Seeded User",
        password_hash=hash_password("correct-horse"),
        active=True,
        access_level=AccessLevel.MANAGER,
        created_at=datetime.datetime.now(datetime.timezone.utc),
    ))
    db_session.commit()

    resp = client_no_auth.post(f"{API_PREFIX}/auth/login", json={
        "email": "manager@example.com", "password": "correct-horse",
    })
    assert resp.status_code == 200, resp.text

    rows = _entries(db_session)
    assert len(rows) == 1
    assert rows[0].request_body == {
        "email": "manager@example.com", "password": "[redacted]",
    }


def test_multipart_upload_is_not_buffered_and_still_works(
    client, db_session, seeded
):
    doctor_id = seeded["doctor_aa"]
    resp = client.post(
        f"{API_PREFIX}/signatures/{doctor_id}",
        files={"file": ("sig.png", io.BytesIO(b"not-really-a-png"), "image/png")},
    )
    assert resp.status_code == 200, resp.text

    rows = _entries(db_session)
    assert len(rows) == 1
    assert rows[0].request_body is None
    assert rows[0].status_code == 200


def test_unmatched_path_records_a_row_with_null_route(client, db_session):
    resp = client.post(f"{API_PREFIX}/no-such-thing", json={"a": 1})
    assert resp.status_code == 404

    rows = _entries(db_session)
    assert len(rows) == 1
    assert rows[0].route is None
    assert rows[0].path == f"{API_PREFIX}/no-such-thing"
    assert rows[0].status_code == 404


# ---------------------------------------------------------------------------
# Failure paths
# ---------------------------------------------------------------------------

_boom_router = APIRouter(prefix="/audit-test", tags=["audit-test"])


@_boom_router.post("/boom")
def _boom() -> dict:
    raise RuntimeError("kaboom")


@pytest.fixture
def boom_route():
    """Register a route that raises an unhandled exception, for the duration
    of one test. FastAPI caches route matching per app, so the route is
    removed again on teardown to keep it out of every other test's OpenAPI
    schema.

    It is moved to the FRONT of app.routes rather than left where
    include_router appends it. Starlette matches in list order, and
    main.py mounts the built frontend at "/" as the last route, so a route
    appended afterwards sits behind a catch-all and never matches -- but
    only when a frontend HAS been built, which is production and a
    developer machine and never CI. Every route registered the normal way
    is ahead of the mount, so this restores the ordering the app really
    has rather than working around one.
    """
    app.include_router(_boom_router, prefix=API_PREFIX)
    added = app.routes.pop()
    app.routes.insert(0, added)
    try:
        yield f"{API_PREFIX}/audit-test/boom"
    finally:
        app.routes.remove(added)


def test_unhandled_exception_still_writes_a_row_with_status_500(
    session_factory, db_session, boom_route
):
    from fastapi.testclient import TestClient

    from app.api.deps import get_db

    def _override_get_db():
        db = session_factory()
        try:
            yield db
        finally:
            db.close()

    app.dependency_overrides[get_db] = _override_get_db
    try:
        with TestClient(app, raise_server_exceptions=False) as c:
            resp = c.post(boom_route, json={"x": 1})
        assert resp.status_code == 500
    finally:
        app.dependency_overrides.pop(get_db, None)

    rows = _entries(db_session)
    assert len(rows) == 1
    assert rows[0].status_code == 500
    assert rows[0].outcome_detail == "RuntimeError: kaboom"
    assert rows[0].request_body == {"x": 1}


def test_write_failure_does_not_fail_the_request(client, seeded):
    def _broken_factory():
        raise RuntimeError("database is on fire")

    audit.set_session_factory(_broken_factory)
    resp = client.patch(
        f"{API_PREFIX}/doctors/{seeded['doctor_aa']}",
        json={"sessions_per_week": 6},
    )
    assert resp.status_code == 200, resp.text


def test_disabled_factory_writes_nothing(client, db_session, seeded):
    audit.set_session_factory(None)
    resp = client.patch(
        f"{API_PREFIX}/doctors/{seeded['doctor_aa']}",
        json={"sessions_per_week": 6},
    )
    assert resp.status_code == 200, resp.text
    assert _entries(db_session) == []


# ---------------------------------------------------------------------------
# Body handling
# ---------------------------------------------------------------------------


def test_redaction_is_recursive_and_case_insensitive():
    body = {
        "email": "a@example.com",
        "Password": "secret",
        "nested": [{"current_password": "x", "keep": 1}],
        "token": "abc",
    }
    assert audit.redact(body) == {
        "email": "a@example.com",
        "Password": "[redacted]",
        "nested": [{"current_password": "[redacted]", "keep": 1}],
        "token": "[redacted]",
    }


def test_oversized_body_is_stored_as_a_marker(client, db_session, seeded):
    payload = {"code": "A" * (17 * 1024)}
    resp = client.patch(
        f"{API_PREFIX}/doctors/{seeded['doctor_aa']}", json=payload
    )
    # Whatever the endpoint makes of it, the row must not hold the content.
    rows = _entries(db_session)
    assert len(rows) == 1
    assert rows[0].request_body["_audit"] == "body too large"
    assert rows[0].request_body["bytes"] > 16 * 1024
    assert resp.status_code in (200, 409, 422)


def test_unparseable_json_body_is_stored_as_a_marker(client, db_session, seeded):
    resp = client.patch(
        f"{API_PREFIX}/doctors/{seeded['doctor_aa']}",
        content=b"{not json",
        headers={"Content-Type": "application/json"},
    )
    assert resp.status_code == 422

    rows = _entries(db_session)
    assert len(rows) == 1
    assert rows[0].request_body == {"_audit": "unparsed body"}


# ---------------------------------------------------------------------------
# Enrichment: acting user and outcome detail
# ---------------------------------------------------------------------------


def _seed_user(db_session, email, password, access_level=AccessLevel.MANAGER):
    """Insert a real user row. Needed because every authenticated client
    fixture stubs get_current_user out, and the identity hook lives inside
    it -- see the module docstring."""
    user = User(
        email=email,
        name="Seeded User",
        password_hash=hash_password(password),
        active=True,
        access_level=access_level,
        permissions=preset(PRESET_FOR_ACCESS_LEVEL[access_level.value]),
        created_at=datetime.datetime.now(datetime.timezone.utc),
    )
    db_session.add(user)
    db_session.commit()
    db_session.refresh(user)
    return user


def _login(client_no_auth, email, password):
    resp = client_no_auth.post(
        f"{API_PREFIX}/auth/login", json={"email": email, "password": password}
    )
    assert resp.status_code == 200, resp.text
    return {"Authorization": f"Bearer {resp.json()['token']}"}


def _last(db_session):
    """The newest row. The login these tests perform is itself audited, so
    assertions look at the last row rather than the only one."""
    return _entries(db_session)[-1]


def test_authenticated_write_records_the_acting_user(client_no_auth, db_session):
    user = _seed_user(db_session, "manager@example.com", "correct-horse")
    headers = _login(client_no_auth, "manager@example.com", "correct-horse")

    resp = client_no_auth.post(
        f"{API_PREFIX}/doctors",
        json={"code": "ZZ", "doctor_type": "Partner"},
        headers=headers,
    )
    assert resp.status_code == 201, resp.text

    row = _last(db_session)
    assert row.path == f"{API_PREFIX}/doctors"
    assert row.status_code == 201
    assert row.user_id == user.id
    assert row.user_email == "manager@example.com"
    # A plain string, not an enum -- historical rows must survive a tier
    # being renamed.
    assert row.user_access_level == "manager"
    # And the permission set that actually allowed it, as compact sorted
    # JSON: "why was this allowed?" has to stay answerable after the user's
    # permissions change.
    assert row.user_permissions == json.dumps(
        preset(MANAGER_PRESET), sort_keys=True
    )


def test_unauthenticated_write_records_a_row_with_no_user(client_no_auth, db_session):
    resp = client_no_auth.post(
        f"{API_PREFIX}/doctors", json={"code": "ZZ", "doctor_type": "Partner"}
    )
    assert resp.status_code == 401

    row = _last(db_session)
    assert row.status_code == 401
    assert row.user_id is None
    assert row.user_email is None
    assert row.user_access_level is None
    assert row.user_permissions is None
    assert row.outcome_detail == "Not authenticated"


def test_forbidden_write_records_the_user_and_the_reason(client_no_auth, db_session):
    user = _seed_user(
        db_session, "nurse@example.com", "correct-horse", AccessLevel.NURSE
    )
    headers = _login(client_no_auth, "nurse@example.com", "correct-horse")

    resp = client_no_auth.post(
        f"{API_PREFIX}/doctors",
        json={"code": "ZZ", "doctor_type": "Partner"},
        headers=headers,
    )
    assert resp.status_code == 403

    row = _last(db_session)
    assert row.status_code == 403
    # The user is recorded even though the request was refused: the gate
    # runs after get_current_user, which is where identity is captured.
    assert row.user_id == user.id
    assert row.user_access_level == "nurse"
    assert row.outcome_detail == "Your access to the clinical rota is read-only"


def test_validation_error_records_the_field_and_the_message(
    client_no_auth, db_session
):
    _seed_user(db_session, "manager@example.com", "correct-horse")
    headers = _login(client_no_auth, "manager@example.com", "correct-horse")

    resp = client_no_auth.post(
        f"{API_PREFIX}/doctors", json={"doctor_type": "Partner"}, headers=headers
    )
    assert resp.status_code == 422

    row = _last(db_session)
    assert row.status_code == 422
    assert row.outcome_detail is not None
    assert "body.code" in row.outcome_detail
    assert "Field required" in row.outcome_detail


def test_successful_login_records_the_user_it_logged_in(client_no_auth, db_session):
    user = _seed_user(db_session, "manager@example.com", "correct-horse")
    _login(client_no_auth, "manager@example.com", "correct-horse")

    row = _last(db_session)
    assert row.path == f"{API_PREFIX}/auth/login"
    assert row.status_code == 200
    assert row.user_id == user.id
    assert row.user_email == "manager@example.com"
    assert row.user_access_level == "manager"


def test_failed_login_records_the_reason_and_no_user(client_no_auth, db_session):
    _seed_user(db_session, "manager@example.com", "correct-horse")

    resp = client_no_auth.post(f"{API_PREFIX}/auth/login", json={
        "email": "manager@example.com", "password": "wrong",
    })
    assert resp.status_code == 401

    row = _last(db_session)
    assert row.user_id is None
    assert row.outcome_detail == "Invalid email or password"
    # The body still identifies who was trying, with the password redacted.
    assert row.request_body == {
        "email": "manager@example.com", "password": "[redacted]",
    }


def test_logout_records_the_acting_user(client_no_auth, db_session):
    user = _seed_user(db_session, "manager@example.com", "correct-horse")
    headers = _login(client_no_auth, "manager@example.com", "correct-horse")

    resp = client_no_auth.post(f"{API_PREFIX}/auth/logout", headers=headers)
    assert resp.status_code == 204

    row = _last(db_session)
    assert row.path == f"{API_PREFIX}/auth/logout"
    assert row.user_id == user.id
