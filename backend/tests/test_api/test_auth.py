"""Real auth-path tests (auth plan, Task 4), replacing the M3.5 shared-token
shim tests wholesale.

Uses `client_no_auth` (conftest) throughout -- the DB is real, but there is
no get_current_user override, so every 401/200 here reflects the actual
deps.py logic, not a test stub. `client` (the overridden fixture used by
every other test file) is deliberately not used in this file.
"""
import datetime

from app.api.auth_utils import hash_password, hash_token, new_session_token
from app.models import User, UserSession

PROTECTED = "/api/v1/rooms"  # any get_current_user-gated GET works here


def _make_user(db_session, email="a@example.com", password="password123", active=True):
    user = User(
        email=email,
        name="A User",
        password_hash=hash_password(password),
        active=active,
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
        before = db_session.query(UserSession).filter_by(user_id=user.id).count()
        assert before == 1

        resp = client_no_auth.post(
            "/api/v1/auth/login",
            json={"email": "a@example.com", "password": "password123"},
        )
        assert resp.status_code == 200, resp.text

        db_session.expire_all()
        remaining = db_session.query(UserSession).filter_by(user_id=user.id).all()
        # The expired row is gone; only the new session from this login remains.
        assert len(remaining) == 1
        assert remaining[0].expires_at > datetime.datetime.now(datetime.timezone.utc)


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