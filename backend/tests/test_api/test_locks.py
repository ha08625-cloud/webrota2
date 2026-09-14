"""The /locks router: reading, acquiring and releasing a section lock.

Every test here seeds REAL user rows. The stub identity in conftest is not
persisted, and `edit_locks.user_id` is a foreign key to `users.id` with the
FK pragma on, so a lock acquired by a stub alone would fail at flush.
conftest's client fixtures insert a row at the stub's own id, which is what
makes the authenticated client and the lock holder the same person.

`_OTHER_ID` is the other user -- the one whose lock the client under test
runs into. Their locks are inserted directly rather than acquired through
the API, because `client_with_permissions` is single-use per test (two
clients would share one identity; see the conftest docstring), so "somebody
else already holds this" has to be set up in the database.

Timestamps are always written explicitly rather than left to the column
defaults. Staleness is a fact about a timestamp, so a test that wants a
stale lock writes one sixteen minutes old and never touches a clock.
"""
import datetime

import pytest

from app.api.main import API_PREFIX
from app.models import EDIT_LOCK_IDLE_TIMEOUT, EditLock, User
from app.models.enums import AccessLevel
from app.models.permissions import (
    MANAGER_PRESET,
    READ_ONLY_PRESET,
    RECEPTION_ADMIN_PRESET,
    default_permissions,
    preset,
)

LOCKS = f"{API_PREFIX}/locks"

# conftest's _StubUser is always id 1; the seeded row has to match it for
# the client and the holder to be one person.
_SELF_ID = 1
_OTHER_ID = 2
_OTHER_NAME = "Kristel Smith"


def _now():
    return datetime.datetime.now(datetime.timezone.utc)


def _seed_user(db_session, user_id, name, email=None):
    db_session.add(User(
        id=user_id,
        email=email or f"user{user_id}@example.com",
        name=name,
        password_hash="x",
        active=True,
        access_level=AccessLevel.MANAGER,
        permissions=preset(MANAGER_PRESET),
        created_at=_now(),
    ))
    db_session.commit()


@pytest.fixture
def users(db_session):
    """The other party, as a real row.

    The caller's own row is no longer seeded here: since the edit lock
    became binding, conftest's client fixtures persist the stub identity
    themselves (see `_seed_stub_user`), and adding it twice is a duplicate
    key.
    """
    _seed_user(db_session, _OTHER_ID, _OTHER_NAME)


def _insert_lock(db_session, area, user_id, idle_for=datetime.timedelta(0)):
    """A lock held by `user_id`, last active `idle_for` ago."""
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


_STALE = EDIT_LOCK_IDLE_TIMEOUT + datetime.timedelta(minutes=1)


class TestAcquire:
    def test_acquiring_a_free_section_takes_it(self, manager_client, users, db_session):
        resp = manager_client.post(f"{LOCKS}/clinical")
        assert resp.status_code == 200, resp.text
        body = resp.json()
        assert body["area"] == "clinical"
        assert body["user_id"] == _SELF_ID
        assert body["user_name"] == "Test User"
        assert body["idle"] is False
        assert _lock_row(db_session, "clinical").user_id == _SELF_ID

    def test_re_entering_does_not_extend_the_holders_own_lock(
        self, manager_client, users, db_session
    ):
        """Entering a section is not editing. If re-acquiring bumped
        `last_activity_at`, anyone could hold a section indefinitely by
        navigating in and out of it -- which is the one thing the idle
        timeout exists to prevent."""
        _insert_lock(db_session, "clinical", _SELF_ID, idle_for=datetime.timedelta(minutes=10))
        before = _lock_row(db_session, "clinical").last_activity_at

        resp = manager_client.post(f"{LOCKS}/clinical")
        assert resp.status_code == 200, resp.text

        assert _lock_row(db_session, "clinical").last_activity_at == before

    def test_a_fresh_lock_held_by_someone_else_is_a_409(
        self, manager_client, users, db_session
    ):
        _insert_lock(db_session, "clinical", _OTHER_ID)

        resp = manager_client.post(f"{LOCKS}/clinical")
        assert resp.status_code == 409, resp.text
        detail = resp.json()["detail"]
        assert detail["code"] == "edit_lock_held"
        assert detail["area"] == "clinical"
        assert detail["holder_user_id"] == _OTHER_ID
        assert detail["holder_name"] == _OTHER_NAME
        assert detail["message"] == f"{_OTHER_NAME} is editing the clinical rota"
        # Offset-aware, for the same reason the list payload is: the
        # dialog tells the user when the holder started, and a naive ISO
        # string is read as local time by the browser.
        assert detail["acquired_at"] and detail["last_activity_at"]
        assert datetime.datetime.fromisoformat(detail["acquired_at"]).tzinfo is not None
        # Refused, not taken.
        assert _lock_row(db_session, "clinical").user_id == _OTHER_ID

    def test_a_stale_lock_held_by_someone_else_is_replaced(
        self, manager_client, users, db_session
    ):
        _insert_lock(db_session, "clinical", _OTHER_ID, idle_for=_STALE)

        resp = manager_client.post(f"{LOCKS}/clinical")
        assert resp.status_code == 200, resp.text
        assert resp.json()["user_id"] == _SELF_ID
        assert resp.json()["idle"] is False

        row = _lock_row(db_session, "clinical")
        assert row.user_id == _SELF_ID
        # One row per section, still: the old holder's was deleted, not
        # left behind under a second key.
        assert db_session.query(EditLock).count() == 1

    def test_the_two_sections_lock_independently(
        self, manager_client, users, db_session
    ):
        _insert_lock(db_session, "reception", _OTHER_ID)

        assert manager_client.post(f"{LOCKS}/clinical").status_code == 200
        assert _lock_row(db_session, "reception").user_id == _OTHER_ID

    def test_an_unlockable_area_is_422(self, manager_client, users):
        """Checked before the permission gate: "that is not a section" is a
        fact about the request, not about the caller."""
        for area in ("signatures", "user_admin", "nonsense"):
            resp = manager_client.post(f"{LOCKS}/{area}")
            assert resp.status_code == 422, f"{area} -> {resp.status_code}"

    def test_a_read_only_login_cannot_acquire(self, readonly_client, users, db_session):
        """A login that can never write a section can never block anyone in
        it either."""
        resp = readonly_client.post(f"{LOCKS}/clinical")
        assert resp.status_code == 403, resp.text
        assert _lock_row(db_session, "clinical") is None

    def test_a_login_with_no_access_at_all_cannot_acquire(
        self, no_access_client, users
    ):
        assert no_access_client.post(f"{LOCKS}/clinical").status_code == 403

    def test_write_in_one_section_is_not_write_in_the_other(
        self, reception_admin_client, users, db_session
    ):
        """The Reception admin preset holds reception at write and clinical
        at read, so it may lock exactly one of the two."""
        assert reception_admin_client.post(f"{LOCKS}/reception").status_code == 200
        assert reception_admin_client.post(f"{LOCKS}/clinical").status_code == 403
        assert _lock_row(db_session, "clinical") is None


class TestList:
    def test_it_lists_locks_with_the_holders_name(
        self, manager_client, users, db_session
    ):
        _insert_lock(db_session, "clinical", _OTHER_ID)

        body = manager_client.get(LOCKS).json()
        assert [entry["area"] for entry in body] == ["clinical"]
        assert body[0]["user_name"] == _OTHER_NAME
        assert body[0]["user_id"] == _OTHER_ID
        assert body[0]["idle"] is False

    def test_timestamps_carry_a_utc_offset(self, manager_client, users, db_session):
        """The banner reads `acquired_at` to say how long ago the holder
        started, and `new Date()` in the browser parses an ISO string with
        no offset as LOCAL time. SQLite hands these columns back naive, so
        without the `as_utc` in `_out` this payload would be right on
        Postgres and wrong by the viewer's offset in development -- the
        worst shape of bug to find later."""
        _insert_lock(db_session, "clinical", _OTHER_ID)

        body = manager_client.get(LOCKS).json()
        for field in ("acquired_at", "last_activity_at"):
            parsed = datetime.datetime.fromisoformat(body[0][field])
            assert parsed.tzinfo is not None, body[0][field]
            assert parsed.utcoffset() == datetime.timedelta(0)

    def test_an_idle_lock_is_flagged_but_not_deleted(
        self, manager_client, users, db_session
    ):
        """Staleness is evaluated, never swept: polling this endpoint must
        have no side effects, or a holder would lose their lock to a banner
        refresh in an empty room."""
        _insert_lock(db_session, "clinical", _OTHER_ID, idle_for=_STALE)

        body = manager_client.get(LOCKS).json()
        assert body[0]["idle"] is True
        assert _lock_row(db_session, "clinical") is not None

    def test_it_only_reports_sections_the_caller_can_read(
        self, client_with_permissions, users, db_session
    ):
        """A reception-only login has no business learning who is in the
        clinical rota."""
        _insert_lock(db_session, "clinical", _OTHER_ID)
        _insert_lock(db_session, "reception", _OTHER_ID)

        client = client_with_permissions({
            "clinical": "none",
            "reception": "write",
            "signatures": False,
            "study_eoi": False,
            "user_admin": False,
        })
        body = client.get(LOCKS).json()
        assert [entry["area"] for entry in body] == ["reception"]

    def test_a_reader_sees_the_lock_on_a_section_it_cannot_write(
        self, readonly_client, users, db_session
    ):
        """Read level, not write level, is the filter: a read-only login
        never holds a lock but still needs the banner."""
        _insert_lock(db_session, "clinical", _OTHER_ID)

        body = readonly_client.get(LOCKS).json()
        assert [entry["area"] for entry in body] == ["clinical"]

    def test_a_login_with_no_rota_access_sees_nothing(
        self, documents_client, users, db_session
    ):
        _insert_lock(db_session, "clinical", _OTHER_ID)
        _insert_lock(db_session, "reception", _OTHER_ID)

        assert documents_client.get(LOCKS).json() == []

    def test_no_locks_is_an_empty_list(self, manager_client, users):
        resp = manager_client.get(LOCKS)
        assert resp.status_code == 200
        assert resp.json() == []


class TestRelease:
    def test_the_holder_releases_it(self, manager_client, users, db_session):
        _insert_lock(db_session, "clinical", _SELF_ID)

        resp = manager_client.delete(f"{LOCKS}/clinical")
        assert resp.status_code == 204
        assert _lock_row(db_session, "clinical") is None

    def test_releasing_a_lock_held_by_someone_else_is_204_and_a_no_op(
        self, manager_client, users, db_session
    ):
        """The unload beacon cannot read a response, and a tab whose lock
        expired and was taken must not delete the new holder's row."""
        _insert_lock(db_session, "clinical", _OTHER_ID)

        resp = manager_client.delete(f"{LOCKS}/clinical")
        assert resp.status_code == 204
        assert _lock_row(db_session, "clinical").user_id == _OTHER_ID

    def test_releasing_a_lock_nobody_holds_is_204(self, manager_client, users):
        assert manager_client.delete(f"{LOCKS}/clinical").status_code == 204

    def test_release_validates_the_area(self, manager_client, users):
        assert manager_client.delete(f"{LOCKS}/signatures").status_code == 422

    def test_a_read_only_login_cannot_call_release(
        self, readonly_client, users, db_session
    ):
        _insert_lock(db_session, "clinical", _OTHER_ID)
        assert readonly_client.delete(f"{LOCKS}/clinical").status_code == 403
        assert _lock_row(db_session, "clinical") is not None


class TestTheRoundTrip:
    def test_acquire_release_acquire_by_someone_else(
        self, manager_client, users, db_session
    ):
        """The whole point, in one test: a section is blocked while it is
        held and free the moment it is given back."""
        assert manager_client.post(f"{LOCKS}/clinical").status_code == 200
        # Somebody else asking now would be refused -- simulated from the
        # other side, since one test has one identity.
        assert _lock_row(db_session, "clinical").user_id == _SELF_ID

        assert manager_client.delete(f"{LOCKS}/clinical").status_code == 204
        assert _lock_row(db_session, "clinical") is None

        _insert_lock(db_session, "clinical", _OTHER_ID)
        assert manager_client.post(f"{LOCKS}/clinical").status_code == 409
