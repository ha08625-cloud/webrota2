"""Model-level tests for User, UserSession and PasswordResetToken.

Kept as its own module rather than folded into test_models.py -- auth is
a distinct concern from the rota/reference-data models that file covers.
"""
import datetime

import pytest
from sqlalchemy.exc import IntegrityError

from app.models import (
    Doctor,
    PasswordResetToken,
    ReceptionStaff,
    User,
    UserSession,
)
from app.models.enums import AccessLevel, DoctorType
from app.models.permissions import (
    DEFAULT_PERMISSIONS,
    MANAGER_PRESET,
    PERMISSION_KEYS,
    PRESET_FOR_ACCESS_LEVEL,
    PRESETS,
    is_empty,
    preset,
)


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


def _as_utc(value):
    """Read a timestamp back as aware UTC.

    SQLite drops tzinfo on the way out of DateTime(timezone=True), so a row
    written aware returns naive; everything this schema stores is UTC, which
    is the same assumption api/deps.py makes about session expiry.
    """
    if value.tzinfo is None:
        return value.replace(tzinfo=datetime.timezone.utc)
    return value


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


class TestPermissionSets:
    """The permission set as stored on the User row."""

    def test_defaults_to_denying_everything(self, session):
        u = _user(session, email="default-perms@example.com")
        session.commit()
        session.refresh(u)
        assert u.permissions == dict(DEFAULT_PERMISSIONS)
        assert is_empty(u.permissions)

    def test_round_trips_a_set(self, session):
        u = _user(session, email="round-trip@example.com")
        u.permissions = preset(MANAGER_PRESET)
        session.commit()
        session.expire_all()
        assert session.get(User, u.id).permissions == preset(MANAGER_PRESET)

    def test_an_in_place_key_edit_is_tracked(self, session):
        """MutableDict.as_mutable, without which this commits nothing --
        silently. Pinned here as well as through the API because the
        failure mode is invisible at the call site."""
        u = _user(session, email="mutable-model@example.com")
        session.commit()
        u.permissions["reception"] = "write"
        session.commit()
        session.expire_all()
        assert session.get(User, u.id).permissions["reception"] == "write"

    def test_preset_hands_out_a_copy(self, session):
        """A shared dict would let one user's edit rewrite the preset for
        the whole process."""
        first = preset(MANAGER_PRESET)
        first["user_admin"] = False
        assert preset(MANAGER_PRESET)["user_admin"] is True

    @pytest.mark.parametrize("name", sorted(PRESETS))
    def test_every_preset_grants_something(self, name):
        """An empty preset would be a set the API refuses to save, offered
        by the form as a starting point."""
        assert not is_empty(PRESETS[name])
        assert set(PRESETS[name]) == set(PERMISSION_KEYS)

    def test_every_access_level_maps_to_a_preset(self):
        """The 010 backfill and seed_users.py both index this by tier, so a
        missing entry is a KeyError at migration time."""
        assert {level.value for level in AccessLevel} == set(PRESET_FOR_ACCESS_LEVEL)
        assert set(PRESET_FOR_ACCESS_LEVEL.values()) <= set(PRESETS)

    def test_is_empty_is_false_as_soon_as_anything_is_granted(self):
        assert is_empty(dict(DEFAULT_PERMISSIONS))
        assert not is_empty({**DEFAULT_PERMISSIONS, "clinical": "read"})
        assert not is_empty({**DEFAULT_PERMISSIONS, "study_eoi": True})


class TestPasswordResetTokens:
    """The reset-token table. It mirrors UserSession, so these mirror the
    UserSession tests above -- the point is that the mirroring holds."""

    def _token(self, session, user, token_hash="reset-hash", minutes=60):
        t = PasswordResetToken(
            token_hash=token_hash,
            user_id=user.id,
            created_at=datetime.datetime.now(datetime.timezone.utc),
            expires_at=(
                datetime.datetime.now(datetime.timezone.utc)
                + datetime.timedelta(minutes=minutes)
            ),
        )
        session.add(t)
        session.flush()
        return t

    def test_crud(self, session):
        u = _user(session, email="reset-crud@example.com")
        t = self._token(session, u)
        fetched = session.get(PasswordResetToken, t.id)
        assert fetched.user_id == u.id
        assert fetched.token_hash == "reset-hash"

    def test_created_at_defaults_to_now(self, session):
        """The global hourly cap counts on this column, so a row written
        without one would be uncountable rather than merely untidy."""
        u = _user(session, email="reset-default@example.com")
        before = datetime.datetime.now(datetime.timezone.utc)
        t = PasswordResetToken(
            token_hash="defaulted", user_id=u.id, expires_at=_expiry(),
        )
        session.add(t)
        session.flush()
        session.refresh(t)
        assert t.created_at is not None
        assert _as_utc(t.created_at) >= before - datetime.timedelta(seconds=1)

    def test_relationship(self, session):
        u = _user(session, email="reset-rel@example.com")
        self._token(session, u, token_hash="r1")
        self._token(session, u, token_hash="r2")
        session.refresh(u)
        assert len(u.password_reset_tokens) == 2
        assert u.password_reset_tokens[0].user is u

    def test_deleting_user_cascades_tokens(self, session):
        """ORM-level cascade, as everywhere else in this schema -- there is
        no ON DELETE CASCADE to fall back on."""
        u = _user(session, email="reset-cascade@example.com")
        self._token(session, u)
        session.flush()

        session.delete(u)
        session.flush()

        remaining = (
            session.query(PasswordResetToken).filter_by(user_id=u.id).all()
        )
        assert remaining == []

    def test_token_hash_unique(self, session):
        u = _user(session, email="reset-unique@example.com")
        self._token(session, u, token_hash="same-reset-hash")
        other = _user(session, email="reset-unique2@example.com")
        session.add(PasswordResetToken(
            token_hash="same-reset-hash", user_id=other.id,
            created_at=datetime.datetime.now(datetime.timezone.utc),
            expires_at=_expiry(),
        ))
        with pytest.raises(IntegrityError):
            session.flush()

    def test_token_for_nonexistent_user_is_rejected(self, session):
        session.add(PasswordResetToken(
            token_hash="orphan", user_id=9999,
            created_at=datetime.datetime.now(datetime.timezone.utc),
            expires_at=_expiry(),
        ))
        with pytest.raises(IntegrityError):
            session.flush()

    def test_a_user_may_hold_several_tokens(self, session):
        """Nothing at the model layer enforces one-at-a-time: the throttle
        and the delete-all-on-redemption rule live in the endpoint, and the
        table has to be able to represent the state they clean up."""
        u = _user(session, email="reset-many@example.com")
        self._token(session, u, token_hash="m1")
        self._token(session, u, token_hash="m2", minutes=-5)
        session.refresh(u)
        assert len(u.password_reset_tokens) == 2

    def test_timestamps_come_back_naive_under_sqlite(self, session):
        """The trap the redemption code has to know about, pinned here so it
        is found at the model layer rather than as a TypeError in an
        endpoint. SQLite does not round-trip tzinfo through
        DateTime(timezone=True), so a value written aware comes back naive
        and comparing it to `now(timezone.utc)` raises. deps.py already
        normalises UserSession.expires_at for exactly this reason
        (api/deps.py:143-149); whatever reads these rows must do the same.
        Postgres, where this runs in production, returns them aware."""
        u = _user(session, email="reset-tz@example.com")
        t = self._token(session, u)
        session.expire_all()
        fetched = session.get(PasswordResetToken, t.id)

        with pytest.raises(TypeError):
            fetched.expires_at > datetime.datetime.now(datetime.timezone.utc)

        assert _as_utc(fetched.expires_at) > datetime.datetime.now(
            datetime.timezone.utc
        )
        assert _as_utc(fetched.created_at) <= datetime.datetime.now(
            datetime.timezone.utc
        )
