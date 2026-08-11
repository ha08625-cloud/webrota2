"""Model-level tests for User and UserSession (auth plan, Task 1).

Kept as its own module rather than folded into test_models.py -- auth is
a distinct concern from the rota/reference-data models that file covers.
"""
import datetime

import pytest
from sqlalchemy.exc import IntegrityError

from app.models import User, UserSession
from app.models.enums import AccessLevel


def _user(session, email="a@example.com", name="Ada", active=True):
    u = User(
        email=email,
        name=name,
        password_hash="not-a-real-hash",
        active=active,
        created_at=datetime.datetime.now(datetime.timezone.utc),
    )
    session.add(u)
    session.flush()
    return u


def _expiry(days=30):
    return datetime.datetime.now(datetime.timezone.utc) + datetime.timedelta(days=days)


# --- CRUD ---

def test_user_crud(session):
    u = _user(session)
    fetched = session.get(User, u.id)
    assert fetched.email == "a@example.com"
    assert fetched.active is True


def test_user_session_crud(session):
    u = _user(session)
    s = UserSession(
        token_hash="deadbeef",
        user_id=u.id,
        created_at=datetime.datetime.now(datetime.timezone.utc),
        expires_at=_expiry(),
    )
    session.add(s)
    session.flush()
    assert session.get(UserSession, s.id).user_id == u.id


# --- relationship + cascade ---

def test_user_sessions_relationship(session):
    u = _user(session)
    session.add(UserSession(
        token_hash="hash1", user_id=u.id,
        created_at=datetime.datetime.now(datetime.timezone.utc), expires_at=_expiry(),
    ))
    session.add(UserSession(
        token_hash="hash2", user_id=u.id,
        created_at=datetime.datetime.now(datetime.timezone.utc), expires_at=_expiry(),
    ))
    session.flush()
    session.refresh(u)
    assert len(u.sessions) == 2


def test_deleting_user_cascades_sessions(session):
    u = _user(session)
    session.add(UserSession(
        token_hash="hash1", user_id=u.id,
        created_at=datetime.datetime.now(datetime.timezone.utc), expires_at=_expiry(),
    ))
    session.flush()

    session.delete(u)
    session.flush()

    remaining = session.query(UserSession).filter_by(user_id=u.id).all()
    assert remaining == []


# --- unique constraints ---

def test_user_email_unique(session):
    _user(session, email="dup@example.com")
    session.add(User(
        email="dup@example.com", name="Other", password_hash="x",
        created_at=datetime.datetime.now(datetime.timezone.utc),
    ))
    with pytest.raises(IntegrityError):
        session.flush()


def test_session_token_hash_unique(session):
    u = _user(session)
    session.add(UserSession(
        token_hash="same-hash", user_id=u.id,
        created_at=datetime.datetime.now(datetime.timezone.utc), expires_at=_expiry(),
    ))
    session.flush()
    session.add(UserSession(
        token_hash="same-hash", user_id=u.id,
        created_at=datetime.datetime.now(datetime.timezone.utc), expires_at=_expiry(),
    ))
    with pytest.raises(IntegrityError):
        session.flush()


# --- defaults ---

def test_user_active_defaults_true(session):
    u = User(
        email="default@example.com", name="Default",
        password_hash="x", created_at=datetime.datetime.now(datetime.timezone.utc),
    )
    session.add(u)
    session.flush()
    session.refresh(u)
    assert u.active is True


def test_user_can_be_deactivated(session):
    u = _user(session, active=False)
    assert u.active is False


def test_user_access_level_defaults_to_nurse(session):
    """Least privilege by default (role-based auth plan, Design Decision 7):
    a row inserted without an explicit access_level -- a script, a test, a
    manual INSERT -- is a viewer, never a manager. The API never relies on
    this: UserIn requires access_level."""
    u = User(
        email="tier-default@example.com", name="Default Tier",
        password_hash="x", created_at=datetime.datetime.now(datetime.timezone.utc),
    )
    session.add(u)
    session.flush()
    session.refresh(u)
    assert u.access_level == AccessLevel.NURSE


def test_user_access_level_round_trips(session):
    u = _user(session, email="tier@example.com")
    u.access_level = AccessLevel.MANAGER
    session.flush()
    session.expire_all()
    assert session.get(User, u.id).access_level == AccessLevel.MANAGER
