"""Real auth-path tests (auth plan, Task 4), replacing the M3.5 shared-token
shim tests wholesale.

Uses `client_no_auth` (conftest) throughout -- the DB is real, but there is
no get_current_user override, so every 401/200 here reflects the actual
deps.py logic, not a test stub. `client` (the overridden fixture used by
every other test file) is deliberately not used in this file.
"""
import datetime

from sqlalchemy import func, select

from app.api.auth_utils import hash_password, hash_token, new_session_token
from app.models import Doctor, User, UserSession
from app.models.enums import AccessLevel, DoctorType
from app.models.permissions import PRESET_FOR_ACCESS_LEVEL, preset

PROTECTED = "/api/v1/rooms"  # any get_current_user-gated GET works here


def _as_aware(dt: datetime.datetime) -> datetime.datetime:
    """SQLite does not round-trip tzinfo on DateTime(timezone=True) columns
    -- a row written with an aware UTC value comes back naive after a
    fetch (same fact as the deps.py bugfix this test suite caught).
    Every value ever written to these columns is UTC, so this is a safe
    normalization, not a guess."""
    return dt if dt.tzinfo is not None else dt.replace(tzinfo=datetime.timezone.utc)


def _make_user(
    db_session, email="a@example.com", password="password123", active=True,
    access_level=AccessLevel.MANAGER,
):
    user = User(
        email=email,
        name="A User",
        password_hash=hash_password(password),
        active=active,
        access_level=access_level,
        # The gates read `permissions`, not the tier, and the column
        # defaults to deny-everything -- so a row seeded without one can
        # authenticate but reach nothing. Mirror what the form does and
        # give it the preset its tier maps to.
        permissions=preset(PRESET_FOR_ACCESS_LEVEL[access_level.value]),
        created_at=datetime.datetime.now(datetime.timezone.utc),
    )
    db_session.add(user)
    db_session.commit()
    db_session.refresh(user)
    return user


def _make_session(db_session, user, token=None, expires_delta=datetime.timedelta(days=30)):
    token = token or new_session_token()
    now = datetime.datetime.now(datetime.timezone.utc)
    row = UserSession(
        token_hash=hash_token(token),
        user_id=user.id,
        created_at=now,
        expires_at=now + expires_delta,
    )
    db_session.add(row)
    db_session.commit()
    return token


def _session_count(db_session, user_id):
    return db_session.execute(
        select(func.count()).select_from(UserSession).where(UserSession.user_id == user_id)
    ).scalar_one()


class TestUnauthenticated:
    def test_401_with_no_header(self, client_no_auth):
        resp = client_no_auth.get(PROTECTED)
        assert resp.status_code == 401

    def test_401_with_malformed_header(self, client_no_auth):
        resp = client_no_auth.get(PROTECTED, headers={"Authorization": "not-bearer-at-all"})
        assert resp.status_code == 401

    def test_401_with_unknown_token(self, client_no_auth):
        resp = client_no_auth.get(
            PROTECTED, headers={"Authorization": "Bearer nonexistent-token"}
        )
        assert resp.status_code == 401

    def test_health_open_with_no_auth(self, client_no_auth):
        assert client_no_auth.get("/health").status_code == 200


class TestLogin:
    def test_login_happy_path_returns_token_and_it_works(self, client_no_auth, db_session):
        _make_user(db_session, email="a@example.com", password="password123")

        resp = client_no_auth.post(
            "/api/v1/auth/login",
            json={"email": "a@example.com", "password": "password123"},
        )
        assert resp.status_code == 200, resp.text
        body = resp.json()
        assert body["user"]["email"] == "a@example.com"
        assert body["user"]["access_level"] == "manager"
        assert "password" not in body["user"]
        assert "password_hash" not in body["user"]
        token = body["token"]

        protected = client_no_auth.get(
            PROTECTED, headers={"Authorization": f"Bearer {token}"}
        )
        assert protected.status_code == 200

    def test_wrong_password_401(self, client_no_auth, db_session):
        _make_user(db_session, email="a@example.com", password="password123")
        resp = client_no_auth.post(
            "/api/v1/auth/login",
            json={"email": "a@example.com", "password": "wrong-password"},
        )
        assert resp.status_code == 401

    def test_unknown_email_401(self, client_no_auth, db_session):
        resp = client_no_auth.post(
            "/api/v1/auth/login",
            json={"email": "nobody@example.com", "password": "password123"},
        )
        assert resp.status_code == 401

    def test_inactive_user_cannot_log_in(self, client_no_auth, db_session):
        _make_user(db_session, email="a@example.com", password="password123", active=False)
        resp = client_no_auth.post(
            "/api/v1/auth/login",
            json={"email": "a@example.com", "password": "password123"},
        )
        assert resp.status_code == 401

    def test_login_cleans_up_expired_sessions_for_that_user(self, client_no_auth, db_session):
        user = _make_user(db_session, email="a@example.com", password="password123")
        _make_session(db_session, user, expires_delta=datetime.timedelta(days=-1))
        assert _session_count(db_session, user.id) == 1

        resp = client_no_auth.post(
            "/api/v1/auth/login",
            json={"email": "a@example.com", "password": "password123"},
        )
        assert resp.status_code == 200, resp.text

        db_session.expire_all()
        remaining = db_session.execute(
            select(UserSession).where(UserSession.user_id == user.id)
        ).scalars().all()
        # The expired row is gone; only the new session from this login remains.
        assert len(remaining) == 1
        assert _as_aware(remaining[0].expires_at) > datetime.datetime.now(datetime.timezone.utc)


class TestSessionLifecycle:
    def test_expired_session_401(self, client_no_auth, db_session):
        user = _make_user(db_session)
        token = _make_session(db_session, user, expires_delta=datetime.timedelta(days=-1))
        resp = client_no_auth.get(PROTECTED, headers={"Authorization": f"Bearer {token}"})
        assert resp.status_code == 401

    def test_deactivating_user_401s_their_existing_token(self, client_no_auth, db_session):
        user = _make_user(db_session)
        token = _make_session(db_session, user)
        assert client_no_auth.get(
            PROTECTED, headers={"Authorization": f"Bearer {token}"}
        ).status_code == 200

        user.active = False
        db_session.add(user)
        db_session.commit()

        resp = client_no_auth.get(PROTECTED, headers={"Authorization": f"Bearer {token}"})
        assert resp.status_code == 401

    def test_logout_deletes_session_and_token_401s_after(self, client_no_auth, db_session):
        user = _make_user(db_session)
        token = _make_session(db_session, user)
        headers = {"Authorization": f"Bearer {token}"}

        assert client_no_auth.get(PROTECTED, headers=headers).status_code == 200
        assert client_no_auth.post("/api/v1/auth/logout", headers=headers).status_code == 204
        assert client_no_auth.get(PROTECTED, headers=headers).status_code == 401

    def test_me_returns_current_user(self, client_no_auth, db_session):
        user = _make_user(db_session, email="me@example.com")
        token = _make_session(db_session, user)
        resp = client_no_auth.get(
            "/api/v1/auth/me", headers={"Authorization": f"Bearer {token}"}
        )
        assert resp.status_code == 200, resp.text
        assert resp.json()["email"] == "me@example.com"

    def test_me_returns_access_level(self, client_no_auth, db_session):
        """The frontend reads its permission tier off /auth/me
        (role-based auth plan, Task 3)."""
        user = _make_user(
            db_session, email="tier@example.com", access_level=AccessLevel.DOCTOR
        )
        token = _make_session(db_session, user)
        resp = client_no_auth.get(
            "/api/v1/auth/me", headers={"Authorization": f"Bearer {token}"}
        )
        assert resp.status_code == 200, resp.text
        assert resp.json()["access_level"] == "doctor"

    def test_me_returns_the_staff_link(self, client_no_auth, db_session):
        """How the frontend learns which rota person the caller is. Goes
        through a real seeded user and a real session on purpose: most
        fixtures override get_current_user with a stub that has no link at
        all (see test_api/conftest.py), so nothing about this is observable
        through them."""
        doctor = Doctor(
            code="AB", doctor_type=DoctorType.PARTNER,
            sessions_per_week=10, active=True,
        )
        db_session.add(doctor)
        db_session.commit()
        db_session.refresh(doctor)

        user = _make_user(db_session, email="linked@example.com")
        user.doctor_id = doctor.id
        db_session.commit()
        token = _make_session(db_session, user)

        resp = client_no_auth.get(
            "/api/v1/auth/me", headers={"Authorization": f"Bearer {token}"}
        )
        assert resp.status_code == 200, resp.text
        assert resp.json()["linked_doctor"] == {
            "id": doctor.id, "code": "AB", "active": True
        }
        assert resp.json()["linked_reception_staff"] is None

    def test_me_has_no_link_for_an_unlinked_user(self, client_no_auth, db_session):
        user = _make_user(db_session, email="unlinked@example.com")
        token = _make_session(db_session, user)
        resp = client_no_auth.get(
            "/api/v1/auth/me", headers={"Authorization": f"Bearer {token}"}
        )
        assert resp.status_code == 200, resp.text
        assert resp.json()["linked_doctor"] is None
        assert resp.json()["linked_reception_staff"] is None
