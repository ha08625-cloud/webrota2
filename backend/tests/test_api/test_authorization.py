"""Authorization tests (fine-grained permissions plan, Task 2).

The load-bearing tests here are sweeps over every route the app registers,
not per-router enumerations. That is deliberate: the gates' whole value is
that they are default-deny, so the tests that prove it have to be ones that
cover endpoints nobody has written yet. A per-router list would pass
forever while a new unguarded router sailed past it.
`test_route_sweep_is_not_empty` guards the guards -- if a refactor breaks
route collection, the sweeps would otherwise "pass" over zero routes and
prove nothing.

Three sweeps run over the non-GET routes, one per shape of login:
`test_viewer_cannot_write` (read-only: 403 everywhere),
`test_a_rota_login_is_confined_to_the_rota_sections` (the Rota admin
preset: past the gate inside /clinical and /reception, 403 outside them and
on the two endpoints that also need `user_admin`), and
`test_full_permissions_reaches_every_route` (the Manager preset: never the
gate's 403, anywhere). Between them they pin both halves of every area
rule. A fourth sweep,
`test_a_rota_login_reads_the_rota_sections_and_nothing_else`, does the same
for reads, which are gated for the first time under this model.

`test_get_requires_authentication` is about authentication rather than
permissions, and it exists because of the calendar feed (calendar feed
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

Two fixture names carry permission sets, not tiers, and the names are
now a shorthand: `viewer_client` is the Read-only preset, `admin_client`
the Rota admin preset (clinical and reception write, and nothing else --
notably NOT signatures), `manager_client` the Manager preset (everything).
See the conftest.

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
from app.models.permissions import (
    DOCUMENTS_PRESET,
    PRESET_FOR_ACCESS_LEVEL,
    preset,
)

_SAFE = {"GET", "HEAD", "OPTIONS"}
_PARAM = re.compile(r"\{[^}]+\}")

# Routes the registration-time gate deliberately does not cover. /auth is
# ungated (login has no user; logout must work for every login) and
# /users/me is a write every login is allowed to make on their own row.
# Both are covered by their own targeted tests below.
_EXEMPT_PREFIXES = ("/api/v1/auth",)
_EXEMPT_PATHS = ("/api/v1/users/me",)

# Everything outside the two rota sections, by path prefix. A login whose
# permissions cover the rota areas and nothing else -- the Rota admin
# preset, which `admin_client` carries -- must 403 on all of it, reads
# included for the three boolean areas.
_OUTSIDE_THE_ROTA_SECTIONS = (
    "/api/v1/signatures",   # the `signatures` permission
    "/api/v1/eoi",          # `study_eoi`
    "/api/v1/audit",        # `user_admin`
    "/api/v1/users",        # `user_admin`, per-endpoint (the router is ungated)
)

# The two endpoints that need `user_admin` ON TOP of their router's area,
# so a rota editor 403s on them despite being inside a section they can
# otherwise write. The only conjunctions in the API -- see deps.py. Paths
# are as the sweeps generate them, i.e. with "1" substituted for every
# path param.
_ALSO_NEEDS_USER_ADMIN = {
    ("DELETE", "/api/v1/reception/staff/1"),
    ("POST", "/api/v1/doctors/1/calendar-feed/rotate"),
}

# The two reads any authenticated login may make whatever their permission
# set, because a picker in another section needs them (deps._SHARED_READ).
# Asserted against by name below rather than swept over: this is a hole in
# the default-deny property and it should take a deliberate edit to widen.
_SHARED_READ_PATHS = {"/api/v1/doctors", "/api/v1/reception/staff"}

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

# Reads are gated now, so "which reads may this login make" is a real
# question with a swept answer -- see
# `test_a_rota_login_reads_the_rota_sections_and_nothing_else`. The
# signature reads in particular are the reason the feature exists; their
# named assertions live in test_signatures.py's TestReadAccess.

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
    """A read-only login writes nothing, anywhere. No exceptions: the
    Read-only preset holds `read` on the two levelled areas and none of the
    three flags, so every non-GET route in the app is the gate's 403."""
    resp = viewer_client.request(method, path)
    assert resp.status_code == 403, f"{method} {path} -> {resp.status_code}"


@pytest.mark.parametrize("method,path", _NON_GET_ROUTES)
def test_a_rota_login_is_confined_to_the_rota_sections(admin_client, method, path):
    """The Rota admin preset: writes both rota sections, and nothing else.

    Both halves matter. Inside /clinical and /reception the answer must not
    be the gate's 403 -- what it is instead (404, 422, 409, 200) depends on
    the endpoint and is not this test's business. Outside them, and on the
    two endpoints that need `user_admin` as well as their area, it must be
    exactly 403. This is the sweep that would catch a router classified
    into the wrong area in main.py's `_AREA`.
    """
    blocked = (
        path.startswith(_OUTSIDE_THE_ROTA_SECTIONS)
        or (method, path) in _ALSO_NEEDS_USER_ADMIN
    )
    resp = admin_client.request(method, path)
    if blocked:
        assert resp.status_code == 403, f"{method} {path} -> {resp.status_code}"
    else:
        assert resp.status_code != 403, f"{method} {path} -> unexpected 403"


@pytest.mark.parametrize("method,path", _NON_GET_ROUTES)
def test_full_permissions_reaches_every_route(manager_client, method, path):
    """The Manager preset holds every permission, so no gate in the app
    answers it 403 -- including the two conjunctions, which is the point of
    having a preset that holds `user_admin` alongside the areas."""
    resp = manager_client.request(method, path)
    assert resp.status_code != 403, f"{method} {path} -> unexpected 403"


@pytest.mark.parametrize("path", _GET_ROUTES)
def test_a_rota_login_reads_the_rota_sections_and_nothing_else(admin_client, path):
    """Reads are gated too, which is new under this model.

    The three boolean areas have no read exemption -- for signatures that
    is the entire point of the feature -- so a login without the flag 403s
    on their GETs as well as their writes. The exceptions are the two
    shared reads, which every authenticated login may make, and the
    unauthenticated calendar feed, which is ungated in both directions.
    """
    blocked = (
        path.startswith(_OUTSIDE_THE_ROTA_SECTIONS)
        and path not in _SHARED_READ_PATHS
    )
    resp = admin_client.get(path)
    if blocked:
        assert resp.status_code == 403, f"GET {path} -> {resp.status_code}"
    else:
        assert resp.status_code != 403, f"GET {path} -> unexpected 403"


class TestSharedReads:
    """deps._SHARED_READ: two list endpoints any authenticated login may
    call, because a picker in another section needs them. Pinned by name
    and by contents -- this is a permanent hole in the default-deny
    property, so growing it should take a deliberate edit to a test that
    says so."""

    def test_the_allowlist_holds_exactly_these_two_endpoints(self):
        from app.api.deps import _SHARED_READ

        # Un-prefixed: these are matched against the route's own path,
        # which is what `request.scope["route"].path` reports. See deps.py.
        assert _SHARED_READ == frozenset({
            ("GET", "/doctors"),
            ("GET", "/reception/staff"),
        })

    def test_a_documents_only_login_can_read_both_pickers(self, client_at_tier):
        """The login the feature exists to make possible: no rota access at
        all, but it still has to fill a Partner/Salaried picker."""
        client = client_at_tier(permissions=preset(DOCUMENTS_PRESET))
        assert client.get("/api/v1/doctors").status_code == 200
        assert client.get("/api/v1/reception/staff").status_code == 200

    def test_the_allowlist_does_not_leak_the_rest_of_the_router(
        self, client_at_tier
    ):
        """Per-endpoint, not per-router: the doctors router stays clinical,
        and the calendar token in particular is not a shared read."""
        client = client_at_tier(permissions=preset(DOCUMENTS_PRESET))
        assert client.get("/api/v1/doctors/1").status_code == 403
        assert client.get("/api/v1/doctors/1/calendar-feed").status_code == 403


class TestReadsFollowTheAreaLevel:
    """`read` is enough for a GET and not enough for anything else, and
    `none` is not enough for either."""

    @pytest.mark.parametrize("level", list(AccessLevel))
    def test_every_preset_can_read_the_clinical_rota(self, client_at_tier, level):
        """Every tier's preset holds at least `read` on clinical, so the
        rota stays readable to every login the form can create."""
        client = client_at_tier(level)
        assert client.get("/api/v1/rooms").status_code == 200
        assert client.get("/api/v1/doctors").status_code == 200

    def test_doctor_and_nurse_get_the_same_permissions(self):
        """They were permission-identical tiers; they are now labels
        mapping to the same preset."""
        assert (
            PRESET_FOR_ACCESS_LEVEL["doctor"] == PRESET_FOR_ACCESS_LEVEL["nurse"]
        )

    def test_no_access_to_an_area_blocks_its_reads_as_well(self, client_at_tier):
        """The Documents preset holds `none` on both rota areas, so the
        clinical reads that every login could make before this feature are
        403 for it -- bar the two shared ones."""
        client = client_at_tier(permissions=preset(DOCUMENTS_PRESET))
        assert client.get("/api/v1/rooms").status_code == 403
        assert client.get("/api/v1/reception/counters").status_code == 403


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
                "permissions": preset(PRESET_FOR_ACCESS_LEVEL["admin"]),
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
            # The gates read this, not the tier; the column defaults to
            # deny-everything, so a row seeded without one authenticates
            # fine and then reaches nothing.
            permissions=preset(PRESET_FOR_ACCESS_LEVEL["nurse"]),
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

        # A real read-only session: reads fine, writes 403, logout 204.
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
