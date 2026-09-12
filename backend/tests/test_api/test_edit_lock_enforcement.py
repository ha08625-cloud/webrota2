"""The edit lock made binding: require_edit_lock on every section write.

Two halves, and they check different things.

The behavioural half drives real endpoints. `school-holidays` and
`reception/staff` stand in for their whole sections: both are classified in
main.py's `_AREA` like every other router in them, both have a cheap POST
that needs no rota, and nothing about the gate is particular to either. A
test here that fails means the gate is wrong, not that school holidays are.

The structural half inspects the dependencies FastAPI actually registered.
That is the only way to assert the property the wiring exists for -- every
clinical and reception route is lock-gated, and no other route is -- without
writing one behavioural test per router and still missing the next one
somebody adds. It is also what stands in for "a new router classified
`clinical` is gated with no other change": the assertion is over `_AREA`
itself, so a router added to it tomorrow is covered tonight.

Users are real rows, because `edit_locks.user_id` is an FK with the SQLite
FK pragma on. The caller's own row arrives from conftest (`_seed_stub_user`);
only the other party is seeded here. Their locks are inserted directly
rather than acquired through the API, because `client_with_permissions` is
single-use per test -- see the conftest docstring.
"""
import datetime

import pytest
from sqlalchemy import text

from app.api.main import API_PREFIX, _AREA, _UNGATED, app
from app.models import EDIT_LOCK_IDLE_TIMEOUT, EditLock, User
from app.models.enums import AccessLevel
from app.models.permissions import LOCKABLE_AREAS, MANAGER_PRESET, preset

CLINICAL_WRITE = f"{API_PREFIX}/schools"
RECEPTION_WRITE = f"{API_PREFIX}/reception/staff"

_OTHER_ID = 2
_OTHER_NAME = "Kristel Smith"
_STALE = EDIT_LOCK_IDLE_TIMEOUT + datetime.timedelta(minutes=1)


def _now():
    return datetime.datetime.now(datetime.timezone.utc)


@pytest.fixture
def other_user(db_session):
    """The other party: the person whose lock the caller runs into."""
    db_session.add(User(
        id=_OTHER_ID,
        email="other@example.com",
        name=_OTHER_NAME,
        password_hash="x",
        active=True,
        access_level=AccessLevel.MANAGER,
        permissions=preset(MANAGER_PRESET),
        created_at=_now(),
    ))
    db_session.commit()


def _insert_lock(db_session, area, user_id, idle_for=datetime.timedelta(0)):
    now = _now()
    db_session.add(EditLock(
        area=area,
        user_id=user_id,
        acquired_at=now - idle_for,
        last_activity_at=now - idle_for,
    ))
    db_session.commit()


def _lock_row(db_session, area):
    db_session.expire_all()
    return db_session.get(EditLock, area)


def _post_school(client, name="St Aloysius"):
    return client.post(CLINICAL_WRITE, json={"name": name})


def _post_staff(client, code="RX"):
    return client.post(RECEPTION_WRITE, json={"code": code})


class TestReadsAreNeverBlocked:
    """The whole feature is tolerable only because of this class."""

    def test_a_non_holder_may_still_read_the_clinical_section(
        self, manager_client, other_user, db_session
    ):
        _insert_lock(db_session, "clinical", _OTHER_ID)
        assert manager_client.get(CLINICAL_WRITE).status_code == 200

    def test_a_non_holder_may_still_read_the_reception_section(
        self, manager_client, other_user, db_session
    ):
        _insert_lock(db_session, "reception", _OTHER_ID)
        assert manager_client.get(RECEPTION_WRITE).status_code == 200

    def test_a_read_does_not_create_a_lock(self, manager_client, db_session):
        """The safe-method return happens before any query, so a section
        nobody is editing stays unlocked however much it is read."""
        assert manager_client.get(CLINICAL_WRITE).status_code == 200
        assert _lock_row(db_session, "clinical") is None


class TestWritesAgainstSomeoneElsesLock:
    def test_a_fresh_lock_refuses_the_write_with_the_shared_409(
        self, manager_client, other_user, db_session
    ):
        _insert_lock(db_session, "clinical", _OTHER_ID)

        resp = _post_school(manager_client)
        assert resp.status_code == 409, resp.text
        detail = resp.json()["detail"]
        assert detail["code"] == "edit_lock_held"
        assert detail["area"] == "clinical"
        assert detail["holder_user_id"] == _OTHER_ID
        assert detail["holder_name"] == _OTHER_NAME
        assert detail["message"] == f"{_OTHER_NAME} is editing the clinical rota"
        # The refusal happened before the endpoint, so nothing was written
        # and the holder still holds.
        assert manager_client.get(CLINICAL_WRITE).json() == []
        assert _lock_row(db_session, "clinical").user_id == _OTHER_ID

    def test_the_same_in_reception(self, manager_client, other_user, db_session):
        _insert_lock(db_session, "reception", _OTHER_ID)

        resp = _post_staff(manager_client)
        assert resp.status_code == 409, resp.text
        assert resp.json()["detail"]["area"] == "reception"
        assert resp.json()["detail"]["message"].endswith("the reception rota")

    def test_a_stale_lock_is_taken_over_and_the_write_lands(
        self, manager_client, other_user, db_session
    ):
        _insert_lock(db_session, "clinical", _OTHER_ID, idle_for=_STALE)

        assert _post_school(manager_client).status_code == 201

        row = _lock_row(db_session, "clinical")
        assert row.user_id == 1
        # Taken over, not duplicated: `area` is the primary key, and the
        # old holder's row was deleted rather than left behind.
        assert db_session.query(EditLock).count() == 1

    def test_a_lock_whose_holder_has_vanished_is_takeable(
        self, manager_client, db_session
    ):
        """A holder who cannot be named cannot be honoured either, and a
        section blocked forever is the one outcome nobody can recover from
        without a DBA. routers/locks.py's acquire makes the same judgement.

        The orphan row has to be written with FK enforcement off for the
        length of the insert, because the FK is real and this suite turns
        the SQLite pragma on. That is the point: the state should be
        unreachable -- users are deactivated, never deleted -- and the
        branch exists because "should be" is not "is".
        """
        db_session.execute(text("PRAGMA foreign_keys=OFF"))
        db_session.execute(EditLock.__table__.insert().values(
            area="clinical", user_id=404,
            acquired_at=_now(), last_activity_at=_now(),
        ))
        db_session.commit()
        db_session.execute(text("PRAGMA foreign_keys=ON"))

        assert _post_school(manager_client).status_code == 201
        assert _lock_row(db_session, "clinical").user_id == 1


class TestTheHoldersOwnWrites:
    def test_the_holder_writes_freely_and_the_write_moves_the_timer(
        self, manager_client, db_session
    ):
        """This bump is the idle timer in its entirety. Nothing else stamps
        `last_activity_at` -- there is no heartbeat -- so if this stops
        working a busy holder loses their section after fifteen minutes."""
        _insert_lock(db_session, "clinical", 1, idle_for=datetime.timedelta(minutes=10))
        before = _lock_row(db_session, "clinical").last_activity_at

        assert _post_school(manager_client).status_code == 201

        assert _lock_row(db_session, "clinical").last_activity_at > before

    def test_a_read_by_the_holder_does_not_move_the_timer(
        self, manager_client, db_session
    ):
        """Sitting on a section with it open is not editing it."""
        _insert_lock(db_session, "clinical", 1, idle_for=datetime.timedelta(minutes=10))
        before = _lock_row(db_session, "clinical").last_activity_at

        assert manager_client.get(CLINICAL_WRITE).status_code == 200

        assert _lock_row(db_session, "clinical").last_activity_at == before

    def test_the_bump_survives_an_endpoint_that_then_fails(
        self, manager_client, db_session
    ):
        """Attempting an edit is activity, whether or not the edit landed --
        which is why the gate commits its own bump rather than leaving it to
        an endpoint that may roll back or 4xx."""
        _insert_lock(db_session, "clinical", 1, idle_for=datetime.timedelta(minutes=10))
        before = _lock_row(db_session, "clinical").last_activity_at

        resp = manager_client.delete(f"{API_PREFIX}/schools/999")
        assert resp.status_code == 404

        assert _lock_row(db_session, "clinical").last_activity_at > before


class TestWritingWithNoLock:
    def test_a_write_into_an_unlocked_section_takes_the_lock(
        self, manager_client, db_session
    ):
        """The self-healing case. A failed acquire call, a stale tab or any
        non-browser client must never end up unable to write with no button
        to press: the frontend's acquire-on-entry is a courtesy, the gate is
        the boundary."""
        assert _lock_row(db_session, "clinical") is None

        assert _post_school(manager_client).status_code == 201

        row = _lock_row(db_session, "clinical")
        assert row.user_id == 1
        assert row.acquired_at is not None


class TestTheTwoSectionsAreIndependent:
    def test_a_clinical_lock_does_not_block_a_reception_write(
        self, manager_client, other_user, db_session
    ):
        _insert_lock(db_session, "clinical", _OTHER_ID)

        assert _post_staff(manager_client).status_code == 201

        assert _lock_row(db_session, "reception").user_id == 1
        assert _lock_row(db_session, "clinical").user_id == _OTHER_ID

    def test_a_reception_lock_does_not_block_a_clinical_write(
        self, manager_client, other_user, db_session
    ):
        _insert_lock(db_session, "reception", _OTHER_ID)

        assert _post_school(manager_client).status_code == 201

        assert _lock_row(db_session, "clinical").user_id == 1
        assert _lock_row(db_session, "reception").user_id == _OTHER_ID


class TestGateOrder:
    """403 before 409: "you may never write here" outranks "not right now".

    Both halves matter. A caller who cannot write a section must not be told
    who is in it, and -- the failure that would be far more confusing -- a
    permission problem must never present as a transient one the user is
    invited to wait out.
    """

    def test_a_read_only_login_gets_403_even_when_someone_holds_the_lock(
        self, reception_admin_client, other_user, db_session
    ):
        # The Reception admin preset holds clinical at read.
        _insert_lock(db_session, "clinical", _OTHER_ID)

        resp = _post_school(reception_admin_client)
        assert resp.status_code == 403, resp.text
        assert resp.json()["detail"] == "Your access to the clinical rota is read-only"

    def test_a_login_with_no_access_gets_403_even_when_the_lock_is_free(
        self, no_access_client, db_session
    ):
        """And takes no lock on the way out: a login that can never write a
        section must never appear in it as a holder."""
        resp = _post_school(no_access_client)
        assert resp.status_code == 403, resp.text
        assert _lock_row(db_session, "clinical") is None


# ---------------------------------------------------------------------------
# The wiring itself
# ---------------------------------------------------------------------------

def _lock_areas(dependencies) -> list[str]:
    """The areas these registered dependencies lock, in order.

    `require_edit_lock` returns a closure, so the area it was built around
    lives in a free variable rather than anywhere introspectable by name.
    Read it out of the cell rather than tagging the closure with an
    attribute in production code purely so a test can find it.
    """
    areas = []
    for dep in dependencies:
        func = dep.dependency
        if getattr(func, "__qualname__", "").startswith("require_edit_lock."):
            free = func.__code__.co_freevars
            areas.append(func.__closure__[free.index("area")].cell_contents)
    return areas


def _registered_dependencies(module) -> list:
    """What main.py's loop actually attached to `module`'s router.

    Two shapes, because this is FastAPI's internals and they have moved:
    the current version wraps each include_router call in an opaque
    `_IncludedRouter` holding the arguments it was called with (which is
    also why a running request cannot ask which router served it -- see
    main.py), while older versions copy router-level dependencies onto each
    APIRoute. Either is fine for `_lock_areas`, which picks out only the
    lock closures, so the per-endpoint dependencies the second shape mixes
    in do not matter.

    If neither shape matches, that is this helper being out of date rather
    than the app being ungated, and it says so instead of passing quietly.
    """
    for route in app.routes:
        if getattr(route, "original_router", None) is module.router:
            return list(route.include_context.dependencies)

    paths = {API_PREFIX + r.path for r in module.router.routes}
    for route in app.routes:
        if getattr(route, "path", None) in paths:
            return list(route.dependencies)

    raise AssertionError(
        f"cannot find the registered dependencies for {module.__name__}: "
        "FastAPI's include_router internals have changed shape and this "
        "helper needs updating -- do NOT read this as 'no dependencies'"
    )


class TestEveryRouterIsGatedAsItsAreaSays:
    """The property the registration loop exists for, asserted over `_AREA`
    itself rather than over a list of routers repeated here.

    That is what stands in for "a new router classified `clinical` is
    lock-gated with no other change": a router added to `_AREA` tomorrow is
    covered by these tests tonight. It is also the whole argument for there
    being no separate lock-surface table -- the section a router belongs to
    is recorded exactly once.
    """

    def test_the_lockable_sections_are_gated_on_their_own_area(self):
        checked = 0
        for module, area in _AREA.items():
            if area not in LOCKABLE_AREAS:
                continue
            assert _lock_areas(_registered_dependencies(module)) == [area], (
                f"{module.__name__} is classified {area} but is not "
                "lock-gated on it"
            )
            checked += 1
        assert checked > 0

    def test_the_unlockable_areas_are_untouched(self):
        """Signatures, the EOI tool and the audit log are boolean
        permissions: being locked out means being downgraded to read-only,
        and they have no read level to be downgraded to (see
        models/permissions.LOCKABLE_AREAS)."""
        for module, area in _AREA.items():
            if area in LOCKABLE_AREAS:
                continue
            assert _lock_areas(_registered_dependencies(module)) == [], (
                f"{module.__name__} ({area}) is lock-gated and should not be"
            )

    def test_the_permission_gate_is_registered_first(self):
        """Dependency order is the difference between 403 ("never") and 409
        ("not right now"); TestGateOrder above checks the behaviour, this
        checks the wiring that produces it, so a reordering is caught even
        if a future refactor makes the behavioural case harder to reach."""
        for module, area in _AREA.items():
            if area not in LOCKABLE_AREAS:
                continue
            names = [
                dep.dependency.__qualname__
                for dep in _registered_dependencies(module)
            ]
            access = names.index("require_access.<locals>.dependency")
            lock = names.index("require_edit_lock.<locals>.dependency")
            assert access < lock, module.__name__

    def test_the_ungated_routers_carry_no_lock_gate(self):
        """`locks` most of all: a registration-time lock gate on it would
        refuse the very release call that frees a section."""
        for module in _UNGATED:
            assert _lock_areas(_registered_dependencies(module)) == [], (
                f"{module.__name__} is in _UNGATED but carries a lock gate"
            )
