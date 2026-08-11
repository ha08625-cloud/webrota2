"""Authorization tests (role-based auth plan, Task 2).

The load-bearing test here is `test_viewer_cannot_write`, a sweep over
every non-GET route the app registers, not a per-router enumeration. That
is deliberate: the gate's whole value is that it is default-deny, so the
test that proves it has to be one that covers endpoints nobody has written
yet. A per-router list would pass forever while a new unguarded router
sailed past it. `test_route_sweep_is_not_empty` guards the guard -- if a
refactor breaks route collection, the sweep would otherwise "pass" over
zero routes and prove nothing.

Assertions are `== 403` and never "not 2xx". Most of these requests carry
no body and invalid path params, so a broken gate would answer 422, and
"not 2xx" would happily accept that.

Every test here takes exactly one client fixture. `client_at_tier` and its
`viewer_client` / `admin_client` / `manager_client` wrappers all write to
the single `app.dependency_overrides` dict, so two clients in one test
means one identity for both -- see the conftest docstrings. The one test
that needs an unauthenticated call uses `client_no_auth` on its own.
"""
import re

import pytest

from app.api.main import app
from app.models.enums import AccessLevel

_SAFE = {"GET", "HEAD", "OPTIONS"}
_PARAM = re.compile(r"\{[^}]+\}")

# Routes the global gate deliberately does not cover. /auth is ungated
# (login has no user; logout must work at every tier) and /users/me is a
# write every tier is allowed to make on their own row. Both are covered by
# their own targeted tests below.
_EXEMPT_PREFIXES = ("/api/v1/auth",)
_EXEMPT_PATHS = ("/api/v1/users/me",)

# The sweep covered 78 routes when written. The floor is a tripwire for
# collection silently breaking, not a count to keep in sync -- raise it
# only if it starts feeling loose.
_MIN_SWEPT_ROUTES = 60

# A write that succeeds on its own merits, for the targeted tier tests --
# the sweep sends empty bodies, so it can only ever prove a 403.
DOCTORS = "/api/v1/doctors"
_NEW_DOCTOR = {"code": "ZZ", "doctor_type": "Partner", "sessions_per_week": "10.0"}


def _all_non_get_routes():
    """Every (method, concrete_path) pair the write gate should cover.

    Enumerated from the generated OpenAPI schema rather than by walking
    `app.routes`: FastAPI does not keep a flat list of registered routes on
    the app any more (0.139 wraps each `include_router` call in an opaque
    `_IncludedRouter`), and the schema is the stable public view of what
    the app actually serves. It is complete here because nothing in this
    codebase sets `include_in_schema=False` -- if anything ever does, it
    drops out of the sweep silently, so gate it by hand and say so.

    Path params are filled with "1" regardless of their declared type. A
    `{date}` param will not parse as a date, and that is fine: the gate is
    a sub-dependency, and FastAPI solves sub-dependencies before it
    validates path params or the body, so a viewer's 403 is raised before
    anything has a chance to 422. If that ordering ever changed, these
    tests would fail loudly rather than quietly stop testing the gate.
    """
    collected = []
    for path, operations in app.openapi()["paths"].items():
        if path.startswith(_EXEMPT_PREFIXES) or path in _EXEMPT_PATHS:
            continue
        for method in operations:
            if method.upper() in _SAFE:
                continue
            collected.append((method.upper(), _PARAM.sub("1", path)))
    return sorted(set(collected))


_NON_GET_ROUTES = _all_non_get_routes()


def test_route_sweep_is_not_empty():
    assert len(_NON_GET_ROUTES) >= _MIN_SWEPT_ROUTES, (
        f"route collection found only {len(_NON_GET_ROUTES)} non-GET routes; "
        "the sweep below is no longer testing what it claims to"
    )


@pytest.mark.parametrize("method,path", _NON_GET_ROUTES)
def test_viewer_cannot_write(viewer_client, method, path):
    resp = viewer_client.request(method, path)
    assert resp.status_code == 403, f"{method} {path} -> {resp.status_code}"


@pytest.mark.parametrize("method,path", _NON_GET_ROUTES)
def test_admin_is_not_blocked_by_the_write_gate(admin_client, method, path):
    """The mirror image of the sweep: an admin must get PAST the gate on
    every one of these. What happens next (404, 422, 409, 200) depends on
    the endpoint and is not this test's business -- only that the answer is
    not the gate's 403.

    POST /users and PATCH /users/{id} are in the sweep and DO 403 for an
    admin, from require_manager rather than the write gate; they are the
    documented exception below.
    """
    resp = admin_client.request(method, path)
    if path.startswith("/api/v1/users"):
        assert resp.status_code == 403
    else:
        assert resp.status_code != 403, f"{method} {path} -> unexpected 403"


class TestReadsAreOpenToEveryTier:
    @pytest.mark.parametrize("level", list(AccessLevel))
    def test_every_tier_can_read(self, client_at_tier, level):
        client = client_at_tier(level)
        assert client.get("/api/v1/rooms").status_code == 200
        assert client.get("/api/v1/doctors").status_code == 200

    def test_doctor_and_nurse_are_the_same_tier(self):
        from app.api.deps import _TIER

        assert _TIER[AccessLevel.DOCTOR] == _TIER[AccessLevel.NURSE]


class TestWriteTier:
    def test_viewer_write_is_403_not_422_on_a_valid_body(self, viewer_client):
        """The sweep sends empty bodies, so pin the gate once against a
        request that would otherwise be perfectly valid."""
        assert viewer_client.post(DOCTORS, json=_NEW_DOCTOR).status_code == 403

    def test_doctor_tier_cannot_write(self, client_at_tier):
        client = client_at_tier(AccessLevel.DOCTOR)
        assert client.post(DOCTORS, json=_NEW_DOCTOR).status_code == 403

    def test_admin_can_write(self, admin_client):
        resp = admin_client.post(DOCTORS, json=_NEW_DOCTOR)
        assert resp.status_code == 201, resp.text

    def test_manager_can_write(self, manager_client):
        resp = manager_client.post(DOCTORS, json=_NEW_DOCTOR)
        assert resp.status_code == 201, resp.text

    def test_viewer_delete_is_gated(self, viewer_client):
        assert viewer_client.delete(f"{DOCTORS}/1").status_code == 403


class TestManagerTier:
    """/users is manager-only end to end, GET included -- require_manager is
    method-agnostic, so the write gate's read exemption does not apply."""

    @pytest.mark.parametrize(
        "level", [AccessLevel.NURSE, AccessLevel.DOCTOR, AccessLevel.ADMIN]
    )
    def test_non_managers_cannot_list_users(self, client_at_tier, level):
        assert client_at_tier(level).get("/api/v1/users").status_code == 403

    @pytest.mark.parametrize(
        "level", [AccessLevel.NURSE, AccessLevel.DOCTOR, AccessLevel.ADMIN]
    )
    def test_non_managers_cannot_create_users(self, client_at_tier, level):
        resp = client_at_tier(level).post(
            "/api/v1/users",
            json={
                "email": "new@example.com", "name": "New",
                "password": "password123", "access_level": "nurse",
            },
        )
        assert resp.status_code == 403

    def test_manager_can_list_and_create_users(self, manager_client):
        resp = manager_client.post(
            "/api/v1/users",
            json={
                "email": "new@example.com", "name": "New",
                "password": "password123", "access_level": "admin",
            },
        )
        assert resp.status_code == 201, resp.text
        assert manager_client.get("/api/v1/users").status_code == 200


class TestSignatureApplyIsGated:
    """Design Decision 3: POST /signatures/{doctor_id}/apply writes nothing
    -- it returns a generated PDF -- but is gated as a write anyway, because
    an exemption list is a permanent hole in default-deny for one route.
    Pinned explicitly so that reversing the decision is a deliberate edit to
    a named test rather than a silent side effect."""

    def test_viewer_cannot_apply_a_signature(self, viewer_client):
        resp = viewer_client.post("/api/v1/signatures/1/apply")
        assert resp.status_code == 403


class TestAuthRouterIsUngated:
    def test_login_works_unauthenticated(self, client_no_auth, db_session):
        import datetime

        from app.api.auth_utils import hash_password
        from app.models import User

        db_session.add(User(
            email="viewer@example.com",
            name="Viewer",
            password_hash=hash_password("password123"),
            active=True,
            access_level=AccessLevel.NURSE,
            created_at=datetime.datetime.now(datetime.timezone.utc),
        ))
        db_session.commit()

        resp = client_no_auth.post(
            "/api/v1/auth/login",
            json={"email": "viewer@example.com", "password": "password123"},
        )
        assert resp.status_code == 200, resp.text
        token = resp.json()["token"]
        headers = {"Authorization": f"Bearer {token}"}

        # A real viewer session: reads fine, writes 403, logout 204.
        assert client_no_auth.get("/api/v1/rooms", headers=headers).status_code == 200
        assert client_no_auth.post(
            DOCTORS, headers=headers, json=_NEW_DOCTOR
        ).status_code == 403
        assert client_no_auth.post(
            "/api/v1/auth/logout", headers=headers
        ).status_code == 204

    def test_unauthenticated_write_is_401_not_403(self, client_no_auth):
        """The gate depends on get_current_user, so a missing token still
        fails as authentication rather than authorization."""
        assert client_no_auth.post(DOCTORS, json=_NEW_DOCTOR).status_code == 401
