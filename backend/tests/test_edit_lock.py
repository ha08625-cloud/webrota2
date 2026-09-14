"""Model-level tests for EditLock and the staleness primitive.

Its own module rather than part of test_models.py: the editing lock is
ephemeral session state, not rota or reference data, and the whole of the
lock feature's later tests will hang off this file.

The naive-datetime case is the point of most of this. SQLite drops tzinfo
on the way out of DateTime(timezone=True), so a lock row read back in the
test suite (and by any code path that re-reads one) carries a naive
last_activity_at; comparing that against an aware `now` raises TypeError.
It is constructed explicitly below rather than fished out of the ORM, so
the test states the shape it is guarding instead of depending on a driver
detail to produce it.
"""
import datetime

import pytest
from sqlalchemy.exc import IntegrityError

from app.models import EDIT_LOCK_IDLE_TIMEOUT, EditLock, User, is_stale
from app.models.permissions import AREA_KEYS, LOCKABLE_AREAS

NOW = datetime.datetime(2026, 9, 12, 12, 0, tzinfo=datetime.timezone.utc)


def _user(session, email="holder@example.com", name="Ada"):
    u = User(
        email=email,
        name=name,
        password_hash="not-a-real-hash",
        created_at=NOW,
    )
    session.add(u)
    session.flush()
    return u


def _lock(area="clinical", user_id=1, idle=datetime.timedelta(0)):
    return EditLock(
        area=area,
        user_id=user_id,
        acquired_at=NOW - idle,
        last_activity_at=NOW - idle,
    )


# --- LOCKABLE_AREAS ------------------------------------------------------


def test_lockable_areas_are_levelled_areas():
    """Only a levelled permission has a read level to be downgraded to."""
    assert set(LOCKABLE_AREAS) <= set(AREA_KEYS)


# --- is_stale ------------------------------------------------------------


def test_fresh_lock_is_not_stale():
    assert is_stale(_lock(), NOW) is False


def test_lock_idle_just_under_the_timeout_is_not_stale():
    idle = EDIT_LOCK_IDLE_TIMEOUT - datetime.timedelta(seconds=1)
    assert is_stale(_lock(idle=idle), NOW) is False


def test_lock_idle_past_the_timeout_is_stale():
    idle = EDIT_LOCK_IDLE_TIMEOUT + datetime.timedelta(seconds=1)
    assert is_stale(_lock(idle=idle), NOW) is True


def test_lock_idle_exactly_the_timeout_is_stale():
    """The boundary is inclusive: idle *for* the timeout is takeable."""
    assert is_stale(_lock(idle=EDIT_LOCK_IDLE_TIMEOUT), NOW) is True


@pytest.mark.parametrize(
    "idle, expected",
    [
        (datetime.timedelta(0), False),
        (EDIT_LOCK_IDLE_TIMEOUT + datetime.timedelta(seconds=1), True),
    ],
)
def test_naive_last_activity_does_not_raise(idle, expected):
    """The SQLite read-back shape: tzinfo stripped, value still UTC."""
    lock = _lock(idle=idle)
    lock.last_activity_at = lock.last_activity_at.replace(tzinfo=None)
    assert lock.last_activity_at.tzinfo is None
    assert is_stale(lock, NOW) is expected


def test_is_stale_does_not_mutate_the_lock():
    """Polling calls this on every request; it must have no side effects."""
    lock = _lock(idle=EDIT_LOCK_IDLE_TIMEOUT * 2)
    before = (lock.area, lock.user_id, lock.acquired_at, lock.last_activity_at)
    is_stale(lock, NOW)
    assert (
        lock.area,
        lock.user_id,
        lock.acquired_at,
        lock.last_activity_at,
    ) == before


# --- the table -----------------------------------------------------------


def test_lock_round_trips(session):
    user = _user(session)
    session.add(_lock(user_id=user.id))
    session.commit()

    row = session.get(EditLock, "clinical")
    assert row is not None
    assert row.user_id == user.id
    assert is_stale(row, NOW) is False


def test_area_is_the_primary_key(session):
    """One lock per section, guaranteed by the schema and not by the router."""
    user = _user(session)
    other = _user(session, email="second@example.com", name="Grace")
    session.add(_lock(user_id=user.id))
    session.commit()

    session.add(_lock(user_id=other.id))
    with pytest.raises(IntegrityError):
        session.commit()


def test_both_areas_can_be_locked_at_once(session):
    user = _user(session)
    other = _user(session, email="second@example.com", name="Grace")
    session.add(_lock(area="clinical", user_id=user.id))
    session.add(_lock(area="reception", user_id=other.id))
    session.commit()

    assert {row.area for row in session.query(EditLock)} == {
        "clinical",
        "reception",
    }


def test_user_id_must_reference_a_user(session):
    session.add(_lock(user_id=9999))
    with pytest.raises(IntegrityError):
        session.commit()


def test_timestamps_default_to_now(session):
    """Both default server-side-of-the-ORM, so an acquire need not set them."""
    user = _user(session)
    session.add(EditLock(area="clinical", user_id=user.id))
    session.commit()

    row = session.get(EditLock, "clinical")
    assert row.acquired_at is not None
    assert row.last_activity_at is not None
