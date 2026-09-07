"""Authorization tests (role-based auth plan, Task 2).

There are two load-bearing sweeps. `test_viewer_cannot_write` is a sweep over
every non-GET route the app registers, not a per-router enumeration. That
is deliberate: the gate's whole value is that it is default-deny, so the
test that proves it has to be one that covers endpoints nobody has written
yet. A per-router list would pass forever while a new unguarded router
sailed past it. `test_route_sweep_is_not_empty` guards the guard -- if a
refactor breaks route collection, the sweep would otherwise "pass" over
zero routes and prove nothing.

`test_get_requires_authentication` is the same idea for the other half of
the surface, and it exists because of the calendar feed (calendar feed
plan, Decision 4). That feature opened the app's first and only
unauthenticated endpoint; this sweep is what makes "we opened one hole,
not a class of them" a checked property rather than a claim. It calls
every GET in the schema with no credentials and asserts 401, with
`_UNAUTHENTICATED_GET_PATHS` as the explicit list of what is allowed to
answer otherwise. **Adding a path to that allowlist is a decision, not a
test fix**: it means shipping another endpoint that anyone on the internet
can read.

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

# (method, concrete path) pairs where an admin is SUPPOSED to 403 -- these
# carry require_manager on top of the global write gate, so the sweep's
# "an admin gets past the gate" assertion inverts for them. A set rather
# than a path prefix: manager-only routes are a category now, not one
# router. Paths are as the sweep generates them, i.e. with "1" substituted
# for every path param.
_MANAGER_ONLY = {
    ("POST", "/api/v1/users"),
    ("PATCH", "/api/v1/users/1"),
    ("DELETE", "/api/v1/reception/staff/1"),
    ("POST", "/api/v1/doctors/1/calendar-feed/rotate"),
}

# The sweep covered 78 routes when written. The floor is a tripwire for
# collection silently breaking, not a count to keep in sync -- raise it
# only if it starts feeling loose.
_MIN_SWEPT_ROUTES = 60

# GETs that are SUPPOSED to answer without credentials. Exactly one, and
# it is deliberate: a calendar client cannot present a bearer token, so the
# unguessable token in the path is the credential (see
# app/api/routers/calendar.py). "1" is what the sweep substitutes for the
# {token} path param; it matches no doctor, so the endpoint answers 404 --
# which is the point. The assertion is only that it is not the 401 every
# other GET must give.
_UNAUTHENTICATED_GET_PATHS = {"/api/v1/calendar/1.ics"}

# The GET sweep covered 39 routes when written; same tripwire rationale as
# _MIN_SWEPT_ROUTES above.
_MIN_SWEPT_GET_ROUTES = 30

# GETs that need MORE than a session: "/api/v1/signatures" and
# "/api/v1/signatures/1/image" carry require_admin, so a viewer gets 403
# where every other read gives 200. They are named here for the reader's
# benefit only -- the sweep above tests authentication (401 with no
# credentials), which is unchanged for them, and TestReadsAreOpenToEveryTier
# below tests two named reads rather than sweeping. The tier assertions for
# these two live in test_signatures.py's TestReadAccess.
_ADMIN_ONLY_GET_PATHS = {
    "/api/v1/signatures",
    "/api/v1/signatures/1/image",
}

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


def _all_get_routes():
    """Every concrete GET path the app serves under the API prefix.

    Same enumeration and same caveats as `_all_non_get_routes`. Scoped to
    API_PREFIX so that /health -- registered directly on the app and open
    on purpose, for Railway's health check -- is not swept.
    """
    collected = []
    for path, operations in app.openapi()["paths"].items():
        if not path.startswith("/api/v1"):
            continue
        if "get" in operations:
            collected.append(_PARAM.sub("1", path))
    return sorted(set(collected))


_NON_GET_ROUTES = _all_non_get_routes()
_GET_ROUTES = _all_get_routes()


def test_route_sweep_is_not_empty():
    assert len(_NON_GET_ROUTES) >= _MIN_SWEPT_ROUTES, (
        f"route collection found only {len(_NON_GET_ROUTES)} non-GET routes; "
        "the sweep below is no longer testing what it claims to"
    )


def test_get_route_sweep_is_not_empty():
    assert len(_GET_ROUTES) >= _MIN_SWEPT_GET_ROUTES, (
        f"route collection found only {len(_GET_ROUTES)} GET routes; "
        "the sweep below is no longer testing what it claims to"
    )


@pytest.mark.parametrize("path", _GET_ROUTES)
def test_get_requires_authentication(client_no_auth, path):
    """Every GET in the app needs a session, bar the allowlist.

    The counterpart to `test_viewer_cannot_write`: that sweep proves no
    write escapes the gate, this one proves no read escapes authentication.
    Uses `client_no_auth` because `client` would override get_current_user
    and make the whole question moot. See the module docstring before
    touching `_UNAUTHENTICATED_GET_PATHS`.
    """
    resp = client_no_auth.get(path)
    if path in _UNAUTHENTICATED_GET_PATHS:
        assert resp.status_code != 401, f"GET {path} -> unexpected 401"
    else:
        assert resp.status_code == 401, f"GET {path} -> {resp.status_code}"


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

    The exceptions are the routes in _MANAGER_ONLY above, which carry
    require_manager on top of the write gate and so DO 403 for an admin --
    the assertion inverts for exactly those.
    """
    resp = admin_client.request(method, path)
    if (method, path) in _MANAGER_ONLY:
        assert resp.status_code == 403, f"{method} {path} -> {resp.status_code}"
    else:
        assert resp.status_code != 403, f"{method} {path} -> unexpected 403"


class TestReadsAreOpenToEveryTier:
    """With one deliberate exception: the two signature reads. See
    _ADMIN_ONLY_GET_PATHS above and test_signatures.py's TestReadAccess."""

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
    """POST /signatures/{doctor_id}/apply writes nothing
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
