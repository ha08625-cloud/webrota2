"""Authorization tests (fine-grained permissions plan, Task 3).

The load-bearing tests here are sweeps over every route the app registers,
not per-router enumerations. That is deliberate: the gates' whole value is
that they are default-deny, so the tests that prove it have to be ones that
cover endpoints nobody has written yet. A per-router list would pass
forever while a new unguarded router sailed past it.

Both sweeps run once per PROFILE -- one permission set per preset, plus the
deny-everything set -- against every route, and assert the full expectation
in both directions: `== 403` on every route that profile may not reach,
`!= 403` on every route it may. Never "not 2xx": the sweep sends empty
bodies and invalid path params, so a broken gate would answer 422 and "not
2xx" would happily accept that. What a permitted route answers instead of
403 (200, 404, 409, 422) depends on the endpoint and is not this module's
business.

The expectation is computed, not listed, from three pieces:

  `_AREA_FOR_PREFIX`  which section each path belongs to, written out by
                      hand here rather than imported from main.py's `_AREA`.
                      That duplication is the point -- it is what lets the
                      sweeps catch a router classified into the wrong area,
                      which an imported table could not. The two are held
                      in step by
                      `test_the_area_table_agrees_with_the_app`, so moving
                      a router between sections is a deliberate edit in two
                      places.
  `_SHARED_READ_PATHS`  the two reads every login may make (deps._SHARED_READ).
  `_ALSO_NEEDS_USER_ADMIN`  the two endpoints whose rule is a conjunction.

`_may_reach` turns those into the same rule deps.py implements: a levelled
area admits safe methods at `read` and everything at `write`; a boolean
admits everything or nothing, GETs included.

The floors are per profile, not global. A single global floor cannot catch
the failure they exist for -- one profile's own sweep collapsing to nothing
while the others still run -- so each profile pins how many routes it must
reach and how many it must be blocked on. They are floors, not exact
counts: a new endpoint should not fail them, a silently emptied sweep
should.

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

Every test here takes exactly one client fixture. `client_with_permissions`
and its per-preset wrappers all write to the single
`app.dependency_overrides` dict, so two clients in one test means one
identity for both -- see the conftest docstrings. The one test that needs
an unauthenticated call uses `client_no_auth` on its own.
"""
import re

import pytest

from app.api.main import _AREA, _UNGATED, API_PREFIX, app
from app.models.enums import AccessLevel
from app.models.permissions import (
    DOCUMENTS_PRESET,
    MANAGER_PRESET,
    PRESET_FOR_ACCESS_LEVEL,
    READ_ONLY_PRESET,
    RECEPTION_ADMIN_PRESET,
    ROTA_ADMIN_PRESET,
    default_permissions,
    preset,
)

_SAFE = {"GET", "HEAD", "OPTIONS"}
_PARAM = re.compile(r"\{[^}]+\}")

# Routes the registration-time gate deliberately does not cover: /auth
# (login has no user; logout must work for every login), /calendar (the
# path token is the credential) and /users/me (a write every login is
# allowed to make on its own row). All three are covered by their own
# targeted tests rather than by the sweeps, and appear in
# `_AREA_FOR_PREFIX` / `_UNGATED_PATHS` as area None so the sweeps expect
# them to be reachable by everyone.
_EXEMPT_PREFIXES = (f"{API_PREFIX}/auth",)
_UNGATED_PATHS = frozenset({f"{API_PREFIX}/users/me"})

# Path prefix -> permission area, or None for a route no gate covers.
# Hand-written on purpose; see the module docstring. Matched longest-first
# and on segment boundaries, so /leave does not swallow /leave-planning.
_AREA_FOR_PREFIX = {
    f"{API_PREFIX}/clinic-types": "clinical",
    f"{API_PREFIX}/closures": "clinical",
    f"{API_PREFIX}/counters": "clinical",
    f"{API_PREFIX}/doctors": "clinical",
    f"{API_PREFIX}/duty": "clinical",
    f"{API_PREFIX}/extra-sessions": "clinical",
    f"{API_PREFIX}/leave": "clinical",
    f"{API_PREFIX}/leave-planning": "clinical",
    f"{API_PREFIX}/master-rota": "clinical",
    f"{API_PREFIX}/recurring-notes": "clinical",
    f"{API_PREFIX}/rooms": "clinical",
    f"{API_PREFIX}/rota": "clinical",
    f"{API_PREFIX}/schools": "clinical",
    f"{API_PREFIX}/staging": "clinical",
    f"{API_PREFIX}/reception": "reception",
    f"{API_PREFIX}/signatures": "signatures",
    f"{API_PREFIX}/eoi": "study_eoi",
    f"{API_PREFIX}/audit": "user_admin",
    # The users router is UNGATED and gates its three admin endpoints
    # itself, so this entry describes the effective rule rather than a
    # registration-time one -- which is why it is excluded from
    # `test_the_area_table_agrees_with_the_app`. /users/me is the exception
    # and is listed in `_UNGATED_PATHS` above.
    f"{API_PREFIX}/users": "user_admin",
    f"{API_PREFIX}/auth": None,
    f"{API_PREFIX}/calendar": None,
}

# The two endpoints that need `user_admin` ON TOP of their router's area,
# so a rota editor 403s on them despite being inside a section they can
# otherwise write. The only conjunctions in the API -- see deps.py. Paths
# are as the sweeps generate them, i.e. with "1" substituted for every
# path param.
_ALSO_NEEDS_USER_ADMIN = {
    ("DELETE", f"{API_PREFIX}/reception/staff/1"),
    ("POST", f"{API_PREFIX}/doctors/1/calendar-feed/rotate"),
}

# The two reads any authenticated login may make whatever their permission
# set, because a picker in another section needs them (deps._SHARED_READ).
# Pinned by contents in `TestSharedReads` as well as fed into the sweeps:
# this is a hole in the default-deny property and it should take a
# deliberate edit to widen.
_SHARED_READ_PATHS = frozenset({
    f"{API_PREFIX}/doctors",
    f"{API_PREFIX}/reception/staff",
})

# GETs that are SUPPOSED to answer without credentials. Exactly one, and
# it is deliberate: a calendar client cannot present a bearer token, so the
# unguessable token in the path is the credential (see
# app/api/routers/calendar.py). "1" is what the sweep substitutes for the
# {token} path param; it matches no doctor, so the endpoint answers 404 --
# which is the point. The assertion is only that it is not the 401 every
# other GET must give.
_UNAUTHENTICATED_GET_PATHS = {f"{API_PREFIX}/calendar/1.ics"}

# A write that succeeds on its own merits, for the targeted tests -- the
# sweep sends empty bodies, so it can only ever prove a 403.
DOCTORS = f"{API_PREFIX}/doctors"
_NEW_DOCTOR = {"code": "ZZ", "doctor_type": "Partner", "sessions_per_week": "10.0"}


# ---------------------------------------------------------------------------
# The profiles, and the rule the sweeps expect of them
# ---------------------------------------------------------------------------

# One permission set per preset (models/permissions.PRESETS), plus the
# deny-everything set. Presets are starting points for the admin form
# rather than roles, but they are the sets a real deployment will mostly
# hold; `no_access` is not a legal set to save, but it is the column's
# server default, so the gates have to handle it.
_PROFILES = {
    "manager": preset(MANAGER_PRESET),
    "rota_admin": preset(ROTA_ADMIN_PRESET),
    "reception_admin": preset(RECEPTION_ADMIN_PRESET),
    "documents": preset(DOCUMENTS_PRESET),
    "read_only": preset(READ_ONLY_PRESET),
    "no_access": default_permissions(),
}


def _area_for(path):
    """The area a concrete path falls in, or None if no gate covers it.

    Longest matching prefix, on a segment boundary. An unclassified path
    raises rather than defaulting, so a new section is a loud failure here
    the same way it is a KeyError at import in main.py.
    """
    if path in _UNGATED_PATHS:
        return None
    matches = [
        prefix for prefix in _AREA_FOR_PREFIX
        if path == prefix or path.startswith(f"{prefix}/")
    ]
    if not matches:
        raise KeyError(
            f"{path} matches no prefix in _AREA_FOR_PREFIX -- classify it "
            "(and check main.py's _AREA agrees) rather than widening the "
            "sweep's exemptions"
        )
    return _AREA_FOR_PREFIX[max(matches, key=len)]


def _may_reach(permissions, method, path):
    """Whether a login holding `permissions` should get past the gates.

    The same rule deps.py implements, restated independently: a levelled
    area admits safe methods at `read` and every method at `write`; a
    boolean admits every method when set and none when not, GETs included.
    """
    area = _area_for(path)
    if area is None:
        return True
    if method in _SAFE and path in _SHARED_READ_PATHS:
        allowed = True
    elif area in ("clinical", "reception"):
        granted = permissions.get(area)
        allowed = granted == "write" or (granted == "read" and method in _SAFE)
    else:
        allowed = bool(permissions.get(area))
    if (method, path) in _ALSO_NEEDS_USER_ADMIN:
        allowed = allowed and bool(permissions.get("user_admin"))
    return allowed


# Per-profile tripwires: (routes it must reach, routes it must be blocked
# on). Floors, not counts to keep in sync -- a new endpoint should not fail
# them. A zero is a real zero, not a waiver: `read_only` writes nothing
# anywhere, and `manager` is blocked nowhere, and those are the properties
# their rows assert.
_NON_GET_FLOORS = {
    "manager": (72, 0),
    "rota_admin": (65, 7),
    "reception_admin": (13, 58),
    "documents": (4, 68),
    "read_only": (0, 72),
    "no_access": (0, 72),
}

_GET_FLOORS = {
    "manager": (36, 0),
    "rota_admin": (32, 4),
    "reception_admin": (32, 4),
    "documents": (6, 30),
    "read_only": (32, 4),
    "no_access": (4, 32),
}


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
    validates path params or the body, so a 403 is raised before anything
    has a chance to 422. If that ordering ever changed, these tests would
    fail loudly rather than quietly stop testing the gate.
    """
    collected = []
    for path, operations in app.openapi()["paths"].items():
        if not path.startswith(API_PREFIX) or path.startswith(_EXEMPT_PREFIXES):
            continue
        concrete = _PARAM.sub("1", path)
        if concrete in _UNGATED_PATHS:
            continue
        for method in operations:
            if method.upper() in _SAFE:
                continue
            collected.append((method.upper(), concrete))
    return sorted(set(collected))


def _all_get_routes():
    """Every concrete GET path the app serves under the API prefix.

    Same enumeration and same caveats as `_all_non_get_routes`. Scoped to
    API_PREFIX so that /health -- registered directly on the app and open
    on purpose, for Railway's health check -- is not swept.
    """
    collected = []
    for path, operations in app.openapi()["paths"].items():
        if not path.startswith(API_PREFIX):
            continue
        if "get" in operations:
            collected.append(_PARAM.sub("1", path))
    return sorted(set(collected))


_NON_GET_ROUTES = _all_non_get_routes()
_GET_ROUTES = _all_get_routes()


# ---------------------------------------------------------------------------
# The tables themselves
# ---------------------------------------------------------------------------

class TestTheExpectationTable:
    """The sweeps below are only as good as what they expect. These pin the
    inputs to `_may_reach` -- every swept route classified, the
    classification agreeing with the app, and neither sweep degenerating to
    a single answer for a profile."""

    def test_every_swept_route_is_classified(self):
        """`_area_for` raises on an unclassified path; calling it for every
        route is what turns that into a failure here rather than an error
        inside one parametrised case."""
        for _, path in _NON_GET_ROUTES:
            _area_for(path)
        for path in _GET_ROUTES:
            _area_for(path)

    def test_the_area_table_agrees_with_the_app(self):
        """`_AREA_FOR_PREFIX` is written by hand so the sweeps can catch a
        router put in the wrong section; this is what stops the two drifting
        apart silently. The users router is excluded because it is UNGATED
        and gates itself per endpoint, so main.py has no entry for it.

        Compared through `_area_for` rather than by exact key, because a
        router may sit under another router's prefix -- leave_entitlement
        mounts at /leave/entitlement -- and the longest-prefix match is
        what the sweeps actually apply to its paths."""
        for module, area in _AREA.items():
            prefix = f"{API_PREFIX}{module.router.prefix}"
            assert _area_for(prefix) == area, (
                f"{prefix} is {area!r} in main.py and "
                f"{_area_for(prefix)!r} here"
            )

    def test_every_ungated_router_is_classified_as_ungated_or_self_gating(self):
        """The three routers no registration-time gate covers. /auth and
        /calendar are area None; /users is the one that gates itself, and
        it is classified `user_admin` here because that is the rule its own
        endpoints enforce."""
        prefixes = {f"{API_PREFIX}{m.router.prefix}" for m in _UNGATED}
        assert prefixes == {
            f"{API_PREFIX}/auth",
            f"{API_PREFIX}/calendar",
            f"{API_PREFIX}/users",
        }
        assert _AREA_FOR_PREFIX[f"{API_PREFIX}/auth"] is None
        assert _AREA_FOR_PREFIX[f"{API_PREFIX}/calendar"] is None
        assert _AREA_FOR_PREFIX[f"{API_PREFIX}/users"] == "user_admin"

    @pytest.mark.parametrize("profile", sorted(_PROFILES))
    def test_the_non_get_sweep_is_not_empty_for_this_profile(self, profile):
        permissions = _PROFILES[profile]
        reachable = sum(
            _may_reach(permissions, method, path)
            for method, path in _NON_GET_ROUTES
        )
        min_reach, min_blocked = _NON_GET_FLOORS[profile]
        assert reachable >= min_reach, (
            f"{profile} reaches only {reachable} non-GET routes; the sweep "
            "is no longer testing what it claims to"
        )
        assert len(_NON_GET_ROUTES) - reachable >= min_blocked, (
            f"{profile} is blocked on only "
            f"{len(_NON_GET_ROUTES) - reachable} non-GET routes"
        )

    @pytest.mark.parametrize("profile", sorted(_PROFILES))
    def test_the_get_sweep_is_not_empty_for_this_profile(self, profile):
        permissions = _PROFILES[profile]
        reachable = sum(_may_reach(permissions, "GET", path) for path in _GET_ROUTES)
        min_reach, min_blocked = _GET_FLOORS[profile]
        assert reachable >= min_reach, (
            f"{profile} reaches only {reachable} GET routes; the sweep is "
            "no longer testing what it claims to"
        )
        assert len(_GET_ROUTES) - reachable >= min_blocked, (
            f"{profile} is blocked on only {len(_GET_ROUTES) - reachable} GET routes"
        )


# ---------------------------------------------------------------------------
# The sweeps
# ---------------------------------------------------------------------------

@pytest.mark.parametrize("profile", sorted(_PROFILES))
@pytest.mark.parametrize("method,path", _NON_GET_ROUTES)
def test_every_profile_writes_exactly_what_its_permissions_allow(
    client_with_permissions, profile, method, path
):
    """Both halves of every area rule, for every profile.

    Blocked routes must be exactly 403 -- not 401, not 422, not a 404 that
    happens to look like a denial. Permitted ones must be anything but 403;
    the sweep sends no body, so what they answer instead is the endpoint's
    business, not the gate's.
    """
    permissions = _PROFILES[profile]
    client = client_with_permissions(permissions)
    resp = client.request(method, path)
    if _may_reach(permissions, method, path):
        assert resp.status_code != 403, (
            f"{profile}: {method} {path} -> unexpected 403"
        )
    else:
        assert resp.status_code == 403, (
            f"{profile}: {method} {path} -> {resp.status_code}"
        )


@pytest.mark.parametrize("profile", sorted(_PROFILES))
@pytest.mark.parametrize("path", _GET_ROUTES)
def test_every_profile_reads_exactly_what_its_permissions_allow(
    client_with_permissions, profile, path
):
    """The same sweep for reads, which are gated for the first time under
    this model. The three boolean areas have no read exemption -- for
    signatures that is the entire point of the feature -- so a login
    without the flag 403s on their GETs as well as their writes."""
    permissions = _PROFILES[profile]
    client = client_with_permissions(permissions)
    resp = client.get(path)
    if _may_reach(permissions, "GET", path):
        assert resp.status_code != 403, f"{profile}: GET {path} -> unexpected 403"
    else:
        assert resp.status_code == 403, (
            f"{profile}: GET {path} -> {resp.status_code}"
        )


@pytest.mark.parametrize("path", _GET_ROUTES)
def test_get_requires_authentication(client_no_auth, path):
    """Every GET in the app needs a session, bar the allowlist.

    The counterpart to the sweeps above: they prove no route escapes the
    permission gates, this one proves no read escapes authentication. Uses
    `client_no_auth` because an overridden get_current_user would make the
    question moot. See the module docstring before touching
    `_UNAUTHENTICATED_GET_PATHS`.
    """
    resp = client_no_auth.get(path)
    if path in _UNAUTHENTICATED_GET_PATHS:
        assert resp.status_code != 401, f"GET {path} -> unexpected 401"
    else:
        assert resp.status_code == 401, f"GET {path} -> {resp.status_code}"


# ---------------------------------------------------------------------------
# The named exceptions
# ---------------------------------------------------------------------------

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

    def test_the_sweep_and_the_allowlist_describe_the_same_endpoints(self):
        """`_SHARED_READ_PATHS` is what the sweeps exempt; keeping it in
        step with deps.py is what stops the sweeps quietly excusing a hole
        the app does not actually have, or asserting one it does."""
        from app.api.deps import _SHARED_READ

        assert _SHARED_READ_PATHS == {
            f"{API_PREFIX}{path}" for _, path in _SHARED_READ
        }

    def test_a_documents_only_login_can_read_both_pickers(self, documents_client):
        """The login the feature exists to make possible: no rota access at
        all, but it still has to fill a Partner/Salaried picker."""
        assert documents_client.get(f"{API_PREFIX}/doctors").status_code == 200
        assert (
            documents_client.get(f"{API_PREFIX}/reception/staff").status_code == 200
        )

    def test_the_allowlist_does_not_leak_the_rest_of_the_router(
        self, documents_client
    ):
        """Per-endpoint, not per-router: the doctors router stays clinical,
        and the calendar token in particular is not a shared read."""
        assert documents_client.get(f"{DOCTORS}/1").status_code == 403
        assert (
            documents_client.get(f"{DOCTORS}/1/calendar-feed").status_code == 403
        )


class TestTheConjunctions:
    """The two endpoints gated on `user_admin` as well as their router's
    area. Swept above, and named here because the conjunction is a design
    decision (plan D12) rather than a consequence of the area rules: both
    are destructive in ways routine data entry is not."""

    def test_a_rota_editor_passes_the_area_gate_and_fails_the_capability(
        self, rota_admin_client
    ):
        for method, path in sorted(_ALSO_NEEDS_USER_ADMIN):
            assert rota_admin_client.request(method, path).status_code == 403, (
                f"{method} {path} should need user_admin as well as its area"
            )

    def test_a_user_admin_without_the_area_still_fails(self, client_with_permissions):
        """The other half of the conjunction: `user_admin` alone is not
        enough either, or the guard would have widened rather than
        narrowed."""
        client = client_with_permissions({
            "clinical": "none",
            "reception": "none",
            "signatures": False,
            "study_eoi": False,
            "user_admin": True,
        })
        for method, path in sorted(_ALSO_NEEDS_USER_ADMIN):
            assert client.request(method, path).status_code == 403


class TestUsersGatesItself:
    """The users router is UNGATED so that PATCH /users/me stays open to
    every login; its three admin endpoints carry
    `require_capability("user_admin")` instead. The sweeps cover the three,
    so these pin the exemption itself."""

    def test_users_me_is_reachable_with_no_permissions_at_all(
        self, no_access_client
    ):
        """Not 403: whatever else a login cannot do, it can change its own
        password. An empty body 422s, which is the endpoint's answer and
        not the gate's."""
        resp = no_access_client.patch(f"{API_PREFIX}/users/me", json={})
        assert resp.status_code != 403, resp.text

    def test_the_rest_of_the_router_still_needs_user_admin(self, no_access_client):
        assert no_access_client.get(f"{API_PREFIX}/users").status_code == 403
        assert no_access_client.post(
            f"{API_PREFIX}/users",
            json={
                "email": "new@example.com", "name": "New",
                "password": "password123", "access_level": "nurse",
            },
        ).status_code == 403

    def test_a_user_admin_can_list_and_create(self, manager_client):
        resp = manager_client.post(
            f"{API_PREFIX}/users",
            json={
                "email": "new@example.com", "name": "New",
                "password": "password123", "access_level": "admin",
                "permissions": preset(PRESET_FOR_ACCESS_LEVEL["admin"]),
            },
        )
        assert resp.status_code == 201, resp.text
        assert manager_client.get(f"{API_PREFIX}/users").status_code == 200


class TestReadsFollowTheAreaLevel:
    """`read` is enough for a GET and not enough for anything else, and
    `none` is not enough for either. Swept above; these say it once against
    named endpoints, where a reader looking for the rule will find it."""

    @pytest.mark.parametrize("level", list(AccessLevel))
    def test_every_tier_preset_can_read_the_clinical_rota(
        self, client_with_permissions, level
    ):
        """Every tier's preset holds at least `read` on clinical, so the
        rota stays readable to every login the form's presets can create."""
        client = client_with_permissions(
            preset(PRESET_FOR_ACCESS_LEVEL[level.value])
        )
        assert client.get(f"{API_PREFIX}/rooms").status_code == 200
        assert client.get(DOCTORS).status_code == 200

    def test_doctor_and_nurse_get_the_same_permissions(self):
        """They were permission-identical tiers; they are now labels
        mapping to the same preset."""
        assert (
            PRESET_FOR_ACCESS_LEVEL["doctor"] == PRESET_FOR_ACCESS_LEVEL["nurse"]
        )

    def test_read_is_not_write(self, readonly_client):
        """Pinned against a request that would otherwise be perfectly
        valid: the sweep sends empty bodies, so on its own it could not
        tell a gate's 403 from a gate that had stopped running."""
        assert readonly_client.get(DOCTORS).status_code == 200
        assert readonly_client.post(DOCTORS, json=_NEW_DOCTOR).status_code == 403
        assert readonly_client.delete(f"{DOCTORS}/1").status_code == 403

    def test_no_access_to_an_area_blocks_its_reads_as_well(self, documents_client):
        """The Documents preset holds `none` on both rota areas, so the
        clinical reads that every login could make before this feature are
        403 for it -- bar the two shared ones."""
        assert documents_client.get(f"{API_PREFIX}/rooms").status_code == 403
        assert (
            documents_client.get(f"{API_PREFIX}/reception/counters").status_code
            == 403
        )

    def test_a_reception_admin_reads_the_clinical_rota_but_does_not_write_it(
        self, reception_admin_client
    ):
        """The one preset that mixes levels: reception's rota is built
        against the clinical one, so it gets clinical `read` (plan Q3)."""
        assert reception_admin_client.get(f"{API_PREFIX}/rooms").status_code == 200
        assert (
            reception_admin_client.post(DOCTORS, json=_NEW_DOCTOR).status_code == 403
        )
        assert reception_admin_client.post(
            f"{API_PREFIX}/reception/staff", json={"code": "RZ"}
        ).status_code == 201


class TestSignatureApplyIsGated:
    """POST /signatures/{doctor_id}/apply writes nothing -- it returns a
    generated PDF -- but is gated as a write anyway, because an exemption
    list is a permanent hole in default-deny for one route. Pinned
    explicitly so that reversing the decision is a deliberate edit to a
    named test rather than a silent side effect."""

    def test_a_rota_editor_cannot_apply_a_signature(self, rota_admin_client):
        resp = rota_admin_client.post(f"{API_PREFIX}/signatures/1/apply")
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
            permissions=preset(READ_ONLY_PRESET),
            created_at=datetime.datetime.now(datetime.timezone.utc),
        ))
        db_session.commit()

        resp = client_no_auth.post(
            f"{API_PREFIX}/auth/login",
            json={"email": "viewer@example.com", "password": "password123"},
        )
        assert resp.status_code == 200, resp.text
        token = resp.json()["token"]
        headers = {"Authorization": f"Bearer {token}"}

        # A real read-only session: reads fine, writes 403, logout 204.
        assert client_no_auth.get(
            f"{API_PREFIX}/rooms", headers=headers
        ).status_code == 200
        assert client_no_auth.post(
            DOCTORS, headers=headers, json=_NEW_DOCTOR
        ).status_code == 403
        assert client_no_auth.post(
            f"{API_PREFIX}/auth/logout", headers=headers
        ).status_code == 204

    def test_unauthenticated_write_is_401_not_403(self, client_no_auth):
        """The gate depends on get_current_user, so a missing token still
        fails as authentication rather than authorization."""
        assert client_no_auth.post(DOCTORS, json=_NEW_DOCTOR).status_code == 401
