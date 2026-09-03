"""API test fixtures: TestClient over a fresh in-memory SQLite DB.

`client` overrides the app's get_db dependency so every request runs against
the test engine (same StaticPool + FK-PRAGMA pattern as the project-level
conftest), AND overrides get_current_user with a stub `_test_user` (auth
plan, Task 4) so every other test file keeps working unchanged now that
get_current_user 401s for real. The stub is a lightweight object, not a DB
row: overridden dependencies bypass get_current_user's body entirely, so
nothing ever looks the stub up by id, and no router in this codebase reads
anything off `user` beyond what routers/counters.py's `user: dict` hint
suggests -- if a future router needs a real FK to users, switch that test
to a real row instead of widening the stub.

`client_no_auth` is identical but WITHOUT the get_current_user override --
it exercises the real auth path and is what test_auth.py uses.

`client_at_tier` is a factory for the same thing at a chosen access level,
plus the ready-made `viewer_client` / `admin_client` / `manager_client`
built on it (role-based auth plan, Task 2). All of these share the
single-client-per-test rule described under `client_no_auth` below: they
write to the same `app.dependency_overrides` dict on the same shared `app`,
so requesting two of them (or one of them plus `client` or
`client_no_auth`) in one test means whichever ran last silently decides the
identity for EVERY request through EITHER client. `client_at_tier` refuses
a second call to make that failure loud rather than mysterious.

`_audit_to_test_engine` is autouse and points the audit middleware's
session factory at the per-test engine, so API tests exercise the audit
write path for real rather than skipping it. The ordering is load-bearing:
the project-level conftest has its own autouse fixture setting the factory
to None (the safety net that stops any test writing audit rows into a real
database), and autouse fixtures from a deeper conftest are set up AFTER
shallower ones -- so this one wins for tests under test_api/ and the
disabling default still applies everywhere else. Both restore the previous
value on teardown.

`db_session` hands tests a session on the same engine for direct
assertions against rows the API doesn't expose (e.g. snapshot tables).
`seeded` layers base reference data on top: rooms, two doctors with system
counters, and an active master template covering Monday AM/PM.
"""
import contextlib
import datetime

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, event
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app.database import Base
import app.models  # noqa: F401  (registers all models on Base.metadata)
from app.api.audit import (
    get_session_factory as get_audit_session_factory,
    set_session_factory as set_audit_session_factory,
)
from app.api.deps import get_current_user, get_db
from app.api.main import app
from app.models import (
    Doctor,
    DoctorPreferredRoom,
    MasterRotaSession,
    MasterRotaTemplate,
    ReceptionStaff,
    Room,
    SystemCounter,
)
from app.models.enums import (
    AccessLevel,
    Day,
    DoctorType,
    MasterSessionType,
    Period,
    RoomType,
    Site,
    SystemCounterType,
)
MONDAY = datetime.date(2026, 1, 5)


class _StubUser:
    """Minimal stand-in for a User ORM row (auth plan, Task 4). Not
    persisted -- routers under test never look it up by id, they just read
    attributes off whatever get_current_user returns. The one exception is
    PATCH /users/me, which fetches its own row; tests for that endpoint use
    `client_no_auth` and real logins instead of a stub.

    access_level defaults to MANAGER so that every existing test file keeps
    exercising the full API surface now that the write gate reads this
    attribute (role-based auth plan, Tasks 1 and 2)."""

    def __init__(self, access_level=AccessLevel.MANAGER):
        self.id = 1
        self.email = "test@example.com"
        self.name = "Test User"
        self.active = True
        self.access_level = access_level
        self.created_at = datetime.datetime.now(datetime.timezone.utc)


_test_user = _StubUser()


@pytest.fixture
def api_engine():
    eng = create_engine(
        "sqlite://",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
        future=True,
    )

    @event.listens_for(eng, "connect")
    def _enable_fk(dbapi_connection, _record):
        cur = dbapi_connection.cursor()
        cur.execute("PRAGMA foreign_keys=ON")
        cur.close()

    Base.metadata.create_all(eng)
    yield eng
    Base.metadata.drop_all(eng)
    eng.dispose()


@pytest.fixture
def session_factory(api_engine):
    return sessionmaker(bind=api_engine, autoflush=False, future=True)


@pytest.fixture(autouse=True)
def _audit_to_test_engine(session_factory):
    """Point the audit middleware at the per-test engine. Ordering versus
    the root conftest's disabling fixture is load-bearing -- see the module
    docstring."""
    previous = get_audit_session_factory()
    set_audit_session_factory(session_factory)
    try:
        yield
    finally:
        set_audit_session_factory(previous)


@pytest.fixture
def db_session(session_factory):
    s = session_factory()
    try:
        yield s
    finally:
        s.close()


@pytest.fixture
def client(session_factory):
    def _override_get_db():
        db = session_factory()
        try:
            yield db
        finally:
            db.close()

    app.dependency_overrides[get_db] = _override_get_db
    app.dependency_overrides[get_current_user] = lambda: _test_user
    try:
        with TestClient(app) as c:
            yield c
    finally:
        app.dependency_overrides.pop(get_db, None)
        app.dependency_overrides.pop(get_current_user, None)


@pytest.fixture
def client_no_auth(session_factory):
    """Same DB override as `client`, but WITHOUT the get_current_user
    override -- exercises the real auth path (auth plan, Task 4).

    Do NOT request this fixture together with `client` in the same test.
    app.dependency_overrides is a single dict on the shared `app` object,
    checked at request time, not captured per-fixture-instance -- so
    whichever fixture's setup ran last decides the override in effect for
    EVERY request made through EITHER TestClient for the rest of that
    test, including calls through the other one. No parameter ordering
    fixes this: it is not "client_no_auth's calls are unauthenticated and
    client's are authenticated", it is "whichever override was set last
    applies globally until fixture teardown". The two fixtures are
    mutually exclusive within a single test, full stop. If a test needs
    both a bootstrap step and real-session behaviour, do the bootstrap
    through client_no_auth too -- seed the first user directly via
    db_session (see test_users.py's _seed_user_directly), log in for a
    real token, and use that token's Authorization header for every call.
    """

    def _override_get_db():
        db = session_factory()
        try:
            yield db
        finally:
            db.close()

    app.dependency_overrides[get_db] = _override_get_db
    app.dependency_overrides.pop(get_current_user, None)
    try:
        with TestClient(app) as c:
            yield c
    finally:
        app.dependency_overrides.pop(get_db, None)


@pytest.fixture
def client_at_tier(session_factory):
    """Factory: `client_at_tier(AccessLevel.NURSE)` -> an authenticated
    TestClient whose get_current_user stub sits at that access level
    (role-based auth plan, Task 2).

    Callable once per test, and mutually exclusive with `client` /
    `client_no_auth`, for the reason spelled out in `client_no_auth`'s
    docstring: `app.dependency_overrides` is one dict on one shared `app`,
    read at request time. A second client would not get its own identity --
    it would retarget the first one too, and the test would pass or fail
    for reasons unrelated to what it says it checks. The second call raises
    instead.
    """
    made = []

    def _override_get_db():
        db = session_factory()
        try:
            yield db
        finally:
            db.close()

    with contextlib.ExitStack() as stack:
        def _make(access_level):
            if made:
                raise RuntimeError(
                    "client_at_tier is single-use per test: overrides live on "
                    "one shared app, so a second client would change the "
                    "identity of the first. Split the test."
                )
            made.append(access_level)
            app.dependency_overrides[get_db] = _override_get_db
            app.dependency_overrides[get_current_user] = lambda: _StubUser(access_level)
            stack.callback(app.dependency_overrides.pop, get_current_user, None)
            stack.callback(app.dependency_overrides.pop, get_db, None)
            return stack.enter_context(TestClient(app))

        yield _make


@pytest.fixture
def viewer_client(client_at_tier):
    """Nurse tier. DOCTOR and NURSE are permission-identical, so the tier is
    tested once here and the equivalence is pinned separately."""
    return client_at_tier(AccessLevel.NURSE)


@pytest.fixture
def admin_client(client_at_tier):
    return client_at_tier(AccessLevel.ADMIN)


@pytest.fixture
def manager_client(client_at_tier):
    return client_at_tier(AccessLevel.MANAGER)


@pytest.fixture
def seeded(client, db_session):
    """Base data: rooms C1/D1, doctors AA/BB (+system counters), an active
    template with REQUIRES_ROOM Monday AM/PM for both doctors. Returns ids.
    """
    s = db_session
    c1 = Room(code="C1", room_type=RoomType.C, site=Site.CUTTESLOWE)
    d1 = Room(code="D1", room_type=RoomType.D, site=Site.SHC)
    aa = Doctor(code="AA", doctor_type=DoctorType.PARTNER, sessions_per_week=10, active=True)
    bb = Doctor(code="BB", doctor_type=DoctorType.SALARIED, sessions_per_week=10, active=True)
    s.add_all([c1, d1, aa, bb])
    s.flush()
    for doc in (aa, bb):
        for ct in (SystemCounterType.ROOM_MOVE, SystemCounterType.SUPERVISION):
            s.add(SystemCounter(doctor_id=doc.id, counter_type=ct, raw_count=0))
    template = MasterRotaTemplate(name="Default", is_active=True)
    s.add(template)
    s.flush()
    for doc in (aa, bb):
        for period in (Period.AM, Period.PM):
            s.add(MasterRotaSession(
                template_id=template.id, doctor_id=doc.id, week=1,
                day=Day.MONDAY, period=period,
                session_type=MasterSessionType.REQUIRES_ROOM,
            ))
    s.commit()
    return {
        "room_c1": c1.id, "room_d1": d1.id,
        "doctor_aa": aa.id, "doctor_bb": bb.id,
        "template": template.id,
    }


@pytest.fixture
def seeded_no_d_rooms(client, db_session):
    """Rooms C1/C2 only (no D rooms), doctors AA (Partner, preference-order-1
    C1) and two trainees TT/UU, all REQUIRES_ROOM Monday AM.

    Exists because Pass 3's SR>D>C>W fallback (phase7_9a.py) means a
    Partner/Salaried doctor with no preference list and any free room
    anywhere no longer stays unresolved after generation -- the `seeded`
    fixture's AA/BB pair can no longer produce a guaranteed-empty room next
    to a guaranteed-free room. Trainees have no such fallback (Pass 3 only
    ever touches Partner/Salaried) and Pass 1/2's D-room-only relocation has
    nothing to work with here, so generation deterministically leaves TT and
    UU unresolved while AA claims C1 via preference, leaving C2 genuinely
    free. Used only by the handful of set-room / swap-rooms tests that need
    exactly that combination; everything else still uses `seeded`.
    """
    s = db_session
    c1 = Room(code="C1", room_type=RoomType.C, site=Site.CUTTESLOWE)
    c2 = Room(code="C2", room_type=RoomType.C, site=Site.CUTTESLOWE)
    aa = Doctor(code="AA", doctor_type=DoctorType.PARTNER, sessions_per_week=10, active=True)
    tt = Doctor(code="TT", doctor_type=DoctorType.TRAINEE, sessions_per_week=10, active=True)
    uu = Doctor(code="UU", doctor_type=DoctorType.TRAINEE, sessions_per_week=10, active=True)
    s.add_all([c1, c2, aa, tt, uu])
    s.flush()
    for doc in (aa, tt, uu):
        for ct in (SystemCounterType.ROOM_MOVE, SystemCounterType.SUPERVISION):
            s.add(SystemCounter(doctor_id=doc.id, counter_type=ct, raw_count=0))
    s.add(DoctorPreferredRoom(doctor_id=aa.id, preference_order=1, room_id=c1.id))
    template = MasterRotaTemplate(name="Default", is_active=True)
    s.add(template)
    s.flush()
    for doc in (aa, tt, uu):
        s.add(MasterRotaSession(
            template_id=template.id, doctor_id=doc.id, week=1,
            day=Day.MONDAY, period=Period.AM,
            session_type=MasterSessionType.REQUIRES_ROOM,
        ))
    s.commit()
    return {
        "room_c1": c1.id, "room_c2": c2.id,
        "doctor_aa": aa.id, "doctor_tt": tt.id, "doctor_uu": uu.id,
        "template": template.id,
    }


@pytest.fixture
def seeded_reception(client, db_session):
    """Three active reception staff (RA/RB/RC) plus one inactive (RD).
    Coverage (min_phones_for_hour, a function of the hour) needs no seed data of its
    own -- see app/models/reception.py.
    """
    s = db_session
    ra = ReceptionStaff(code="RA", active=True)
    rb = ReceptionStaff(code="RB", active=True)
    rc = ReceptionStaff(code="RC", active=True)
    rd = ReceptionStaff(code="RD", active=False)
    s.add_all([ra, rb, rc, rd])
    s.flush()
    s.commit()
    return {
        "staff_ra": ra.id, "staff_rb": rb.id, "staff_rc": rc.id,
        "staff_rd_inactive": rd.id,
    }


def make_clinic_type_via_api(client, seeded, name="Dragon"):
    """POST a clinic type scheduled Monday AM, AA-eligible, C1-eligible.

    clinic_priority is server-managed and not part of the request body --
    the created row is appended at the end of the enabled sequence.
    """
    resp = client.post("/api/v1/clinic-types", json={
        "name": name,
        "room_required": True,
        "schedules": [{"day": "Monday", "period": "AM"}],
        "doctor_eligibilities": [{"doctor_id": seeded["doctor_aa"], "doctor_priority": 1}],
        "room_eligibilities": [{"room_id": seeded["room_c1"]}],
    })
    assert resp.status_code == 201, resp.text
    return resp.json()


def generate_rota(client, num_weeks=1, start_date=MONDAY):
    resp = client.post("/api/v1/rota/generate", json={
        "start_date": start_date.isoformat(),
        "num_weeks": num_weeks,
        "template_start_week": 1,
    })
    assert resp.status_code == 200, resp.text
    return resp.json()
