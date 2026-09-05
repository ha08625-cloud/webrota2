"""Model-level tests for User and UserSession (auth plan, Task 1).

Kept as its own module rather than folded into test_models.py -- auth is
a distinct concern from the rota/reference-data models that file covers.
"""
import datetime

import pytest
from sqlalchemy.exc import IntegrityError

from app.models import Doctor, ReceptionStaff, User, UserSession
from app.models.enums import AccessLevel, DoctorType


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
    """Least privilege by default:
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


# --- staff links ---

def _doctor(session, code="AB"):
    d = Doctor(code=code, doctor_type=DoctorType.PARTNER)
    session.add(d)
    session.flush()
    return d


def _reception_staff(session, code="Emily M"):
    r = ReceptionStaff(code=code)
    session.add(r)
    session.flush()
    return r


def test_user_links_default_to_null(session):
    u = _user(session)
    session.refresh(u)
    assert u.doctor_id is None
    assert u.reception_staff_id is None
    assert u.doctor is None
    assert u.reception_staff is None


def test_user_can_link_a_doctor_only(session):
    d = _doctor(session)
    u = _user(session, email="doc@example.com")
    u.doctor_id = d.id
    session.flush()
    session.expire_all()
    fetched = session.get(User, u.id)
    assert fetched.doctor.code == "AB"
    assert fetched.reception_staff_id is None


def test_user_can_link_reception_staff_only(session):
    r = _reception_staff(session)
    u = _user(session, email="recep@example.com")
    u.reception_staff_id = r.id
    session.flush()
    session.expire_all()
    fetched = session.get(User, u.id)
    assert fetched.reception_staff.code == "Emily M"
    assert fetched.doctor_id is None


def test_user_can_link_both(session):
    """A nurse who also covers reception: both columns set on one user is
    allowed, not an either/or."""
    d = _doctor(session)
    r = _reception_staff(session)
    u = _user(session, email="both@example.com")
    u.doctor_id = d.id
    u.reception_staff_id = r.id
    session.flush()
    session.expire_all()
    fetched = session.get(User, u.id)
    assert fetched.doctor.code == "AB"
    assert fetched.reception_staff.code == "Emily M"


def test_two_users_cannot_share_one_doctor(session):
    d = _doctor(session)
    first = _user(session, email="one@example.com")
    first.doctor_id = d.id
    session.flush()
    second = _user(session, email="two@example.com")
    second.doctor_id = d.id
    with pytest.raises(IntegrityError):
        session.flush()


def test_two_users_cannot_share_one_reception_staff(session):
    r = _reception_staff(session)
    first = _user(session, email="one@example.com")
    first.reception_staff_id = r.id
    session.flush()
    second = _user(session, email="two@example.com")
    second.reception_staff_id = r.id
    with pytest.raises(IntegrityError):
        session.flush()


def test_many_users_can_be_unlinked(session):
    """The case a plain unique constraint would break: NULLs are distinct in
    a unique index, so unlinked is a state any number of users may share."""
    for i in range(3):
        _user(session, email=f"none{i}@example.com")
    session.flush()
    unlinked = (
        session.query(User).filter(User.doctor_id.is_(None)).count()
    )
    assert unlinked == 3


def test_link_to_nonexistent_doctor_is_rejected(session):
    u = _user(session, email="ghost@example.com")
    u.doctor_id = 9999
    with pytest.raises(IntegrityError):
        session.flush()


def test_link_to_nonexistent_reception_staff_is_rejected(session):
    u = _user(session, email="ghost2@example.com")
    u.reception_staff_id = 9999
    with pytest.raises(IntegrityError):
        session.flush()


def test_user_can_link_an_inactive_doctor(session):
    """Doctor DELETE is a soft delete, so a link may legitimately point at an
    inactive row; nothing at the model layer forbids it."""
    d = _doctor(session)
    d.active = False
    u = _user(session, email="inactive@example.com")
    u.doctor_id = d.id
    session.flush()
    session.expire_all()
    assert session.get(User, u.id).doctor.active is False


def test_linking_does_not_change_access_level(session):
    """The link is orthogonal to the permission tier: setting doctor_id does
    not promote (or demote) the user."""
    d = _doctor(session)
    u = _user(session, email="tier-link@example.com")
    u.access_level = AccessLevel.MANAGER
    session.flush()
    u.doctor_id = d.id
    session.flush()
    session.expire_all()
    assert session.get(User, u.id).access_level == AccessLevel.MANAGER
