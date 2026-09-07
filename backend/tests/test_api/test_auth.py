"""Real auth-path tests (auth plan, Task 4), replacing the M3.5 shared-token
shim tests wholesale.

Uses `client_no_auth` (conftest) throughout -- the DB is real, but there is
no get_current_user override, so every 401/200 here reflects the actual
deps.py logic, not a test stub. `client` (the overridden fixture used by
every other test file) is deliberately not used in this file.
"""
import datetime
import logging

import pytest
from sqlalchemy import func, select

from app.api.auth_utils import hash_password, hash_token, new_session_token
from app.api.deps import get_email_sender
from app.api.main import app
from app.models import Doctor, PasswordResetToken, User, UserSession
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


FORGOT = "/api/v1/auth/forgot-password"
RESET = "/api/v1/auth/reset-password"


@pytest.fixture
def sent_emails():
    """Capture reset emails instead of sending them.

    Overrides the get_email_sender dependency (api/deps.py) rather than
    monkeypatching app.email, so the test exercises the same wiring
    production uses. BackgroundTasks run to completion inside TestClient
    before the response reaches the test, so asserting on this list
    immediately after a request needs no synchronisation -- including when
    the assertion is that nothing was sent.
    """
    sent: list[tuple[str, str, str]] = []

    def _fake_sender(to_email, name, reset_url):
        sent.append((to_email, name, reset_url))
        return True

    app.dependency_overrides[get_email_sender] = lambda: _fake_sender
    try:
        yield sent
    finally:
        app.dependency_overrides.pop(get_email_sender, None)


def _tokens_for(db_session, user_id):
    return list(db_session.execute(
        select(PasswordResetToken).where(PasswordResetToken.user_id == user_id)
    ).scalars())


def _token_count(db_session):
    return db_session.execute(
        select(func.count()).select_from(PasswordResetToken)
    ).scalar_one()


def _issue_token(db_session, user, age=datetime.timedelta(0),
                 lifetime=datetime.timedelta(hours=1)):
    """Put a reset token in the DB directly and return the raw token.

    `age` backdates created_at (and expires_at with it), which is how the
    throttle and expiry tests move time without patching a clock.
    """
    token = new_session_token()
    created = datetime.datetime.now(datetime.timezone.utc) - age
    db_session.add(PasswordResetToken(
        token_hash=hash_token(token),
        user_id=user.id,
        created_at=created,
        expires_at=created + lifetime,
    ))
    db_session.commit()
    return token


def _reset_token_from_url(url):
    return url.rsplit("/", 1)[-1]


class TestForgotPassword:
    def test_known_active_user_gets_an_email_and_a_token_row(
        self, client_no_auth, db_session, sent_emails
    ):
        user = _make_user(db_session, email="a@example.com")

        resp = client_no_auth.post(FORGOT, json={"email": "a@example.com"})
        assert resp.status_code == 204, resp.text

        assert len(sent_emails) == 1
        to_email, name, reset_url = sent_emails[0]
        assert to_email == "a@example.com"
        assert name == user.name
        assert "/reset-password/" in reset_url

        rows = _tokens_for(db_session, user.id)
        assert len(rows) == 1
        # The raw token is never stored -- only its digest.
        assert rows[0].token_hash == hash_token(_reset_token_from_url(reset_url))

    def test_reset_url_comes_from_app_base_url_not_the_host_header(
        self, client_no_auth, db_session, sent_emails, monkeypatch
    ):
        """Host-header injection is the whole reason APP_BASE_URL exists --
        see _reset_url in routers/auth.py."""
        _make_user(db_session, email="a@example.com")
        monkeypatch.setenv("APP_BASE_URL", "https://rota.example.org/")

        resp = client_no_auth.post(
            FORGOT,
            json={"email": "a@example.com"},
            headers={"Host": "attacker.example"},
        )
        assert resp.status_code == 204, resp.text
        assert sent_emails[0][2].startswith("https://rota.example.org/reset-password/")

    def test_unknown_email_is_204_and_sends_nothing(
        self, client_no_auth, db_session, sent_emails
    ):
        resp = client_no_auth.post(FORGOT, json={"email": "nobody@example.com"})
        assert resp.status_code == 204
        assert sent_emails == []
        assert _token_count(db_session) == 0

    def test_inactive_user_is_204_and_sends_nothing(
        self, client_no_auth, db_session, sent_emails
    ):
        _make_user(db_session, email="gone@example.com", active=False)
        resp = client_no_auth.post(FORGOT, json={"email": "gone@example.com"})
        assert resp.status_code == 204
        assert sent_emails == []
        assert _token_count(db_session) == 0

    def test_email_match_is_case_sensitive_like_login(
        self, client_no_auth, db_session, sent_emails
    ):
        _make_user(db_session, email="a@example.com")
        resp = client_no_auth.post(FORGOT, json={"email": "A@Example.com"})
        assert resp.status_code == 204
        assert sent_emails == []

    def test_second_request_within_the_throttle_sends_nothing(
        self, client_no_auth, db_session, sent_emails
    ):
        user = _make_user(db_session, email="a@example.com")

        assert client_no_auth.post(
            FORGOT, json={"email": "a@example.com"}
        ).status_code == 204
        assert client_no_auth.post(
            FORGOT, json={"email": "a@example.com"}
        ).status_code == 204

        assert len(sent_emails) == 1
        assert len(_tokens_for(db_session, user.id)) == 1

    def test_request_after_the_throttle_window_sends_again(
        self, client_no_auth, db_session, sent_emails
    ):
        user = _make_user(db_session, email="a@example.com")
        _issue_token(db_session, user, age=datetime.timedelta(minutes=5))

        resp = client_no_auth.post(FORGOT, json={"email": "a@example.com"})
        assert resp.status_code == 204
        assert len(sent_emails) == 1
        # The 5-minute-old token is still valid, so both rows are live.
        assert len(_tokens_for(db_session, user.id)) == 2

    def test_global_hourly_cap_suppresses_the_send(
        self, client_no_auth, db_session, sent_emails, caplog
    ):
        """The per-user throttle protects inboxes; this protects the Mailgun
        quota. Rows are spread across other users so the per-user throttle
        is provably not what refuses the request."""
        from app.api.routers.auth import _GLOBAL_HOURLY_CAP

        for i in range(_GLOBAL_HOURLY_CAP):
            other = _make_user(db_session, email=f"filler{i}@example.com")
            _issue_token(db_session, other, age=datetime.timedelta(minutes=30))

        user = _make_user(db_session, email="a@example.com")
        with caplog.at_level(logging.WARNING, logger="app.api.routers.auth"):
            resp = client_no_auth.post(FORGOT, json={"email": "a@example.com"})

        assert resp.status_code == 204
        assert sent_emails == []
        assert _tokens_for(db_session, user.id) == []
        assert "global cap" in caplog.text

    def test_tokens_older_than_the_window_do_not_count_towards_the_cap(
        self, client_no_auth, db_session, sent_emails
    ):
        from app.api.routers.auth import _GLOBAL_HOURLY_CAP

        for i in range(_GLOBAL_HOURLY_CAP):
            other = _make_user(db_session, email=f"filler{i}@example.com")
            _issue_token(db_session, other, age=datetime.timedelta(hours=2))

        _make_user(db_session, email="a@example.com")
        resp = client_no_auth.post(FORGOT, json={"email": "a@example.com"})
        assert resp.status_code == 204
        assert len(sent_emails) == 1

    def test_expired_tokens_for_that_user_are_swept(
        self, client_no_auth, db_session, sent_emails
    ):
        user = _make_user(db_session, email="a@example.com")
        stale = _issue_token(db_session, user, age=datetime.timedelta(hours=2))

        resp = client_no_auth.post(FORGOT, json={"email": "a@example.com"})
        assert resp.status_code == 204

        db_session.expire_all()
        rows = _tokens_for(db_session, user.id)
        assert len(rows) == 1
        assert rows[0].token_hash != hash_token(stale)

    def test_mailgun_failure_is_invisible_to_the_caller(
        self, client_no_auth, db_session
    ):
        """The response has already been sent by the time the background
        task runs, so a failed send cannot change the status code. The
        sender logs its own errors (app/email.py); what is pinned here is
        that a False return -- or a raise -- does not become a 500."""
        def _failing_sender(to_email, name, reset_url):
            return False

        app.dependency_overrides[get_email_sender] = lambda: _failing_sender
        try:
            _make_user(db_session, email="a@example.com")
            resp = client_no_auth.post(FORGOT, json={"email": "a@example.com"})
            assert resp.status_code == 204
        finally:
            app.dependency_overrides.pop(get_email_sender, None)

    def test_no_auth_required(self, client_no_auth, db_session, sent_emails):
        """Pinned explicitly: the route sweep in test_authorization.py
        exempts the whole /auth prefix, so nothing else covers this."""
        resp = client_no_auth.post(FORGOT, json={"email": "nobody@example.com"})
        assert resp.status_code == 204


class TestResetPassword:
    def test_valid_token_sets_the_password_and_clears_everything(
        self, client_no_auth, db_session, sent_emails
    ):
        user = _make_user(db_session, email="a@example.com", password="old-password")
        _make_session(db_session, user)
        _make_session(db_session, user)
        assert _session_count(db_session, user.id) == 2

        client_no_auth.post(FORGOT, json={"email": "a@example.com"})
        token = _reset_token_from_url(sent_emails[0][2])
        # A second live token, to prove redemption clears them all.
        _issue_token(db_session, user, age=datetime.timedelta(minutes=10))

        resp = client_no_auth.post(
            RESET, json={"token": token, "password": "new-password"}
        )
        assert resp.status_code == 204, resp.text

        db_session.expire_all()
        assert _session_count(db_session, user.id) == 0
        assert _tokens_for(db_session, user.id) == []

        assert client_no_auth.post(
            "/api/v1/auth/login",
            json={"email": "a@example.com", "password": "new-password"},
        ).status_code == 200
        assert client_no_auth.post(
            "/api/v1/auth/login",
            json={"email": "a@example.com", "password": "old-password"},
        ).status_code == 401

    def test_unknown_token_400(self, client_no_auth, db_session):
        resp = client_no_auth.post(
            RESET, json={"token": "not-a-real-token", "password": "new-password"}
        )
        assert resp.status_code == 400

    def test_expired_token_400_and_the_row_is_dropped(
        self, client_no_auth, db_session
    ):
        user = _make_user(db_session, email="a@example.com")
        token = _issue_token(db_session, user, age=datetime.timedelta(hours=2))

        resp = client_no_auth.post(
            RESET, json={"token": token, "password": "new-password"}
        )
        assert resp.status_code == 400
        db_session.expire_all()
        assert _tokens_for(db_session, user.id) == []

    def test_a_redeemed_token_cannot_be_used_twice(
        self, client_no_auth, db_session
    ):
        user = _make_user(db_session, email="a@example.com")
        token = _issue_token(db_session, user)

        first = client_no_auth.post(
            RESET, json={"token": token, "password": "new-password"}
        )
        assert first.status_code == 204, first.text

        second = client_no_auth.post(
            RESET, json={"token": token, "password": "newer-password"}
        )
        assert second.status_code == 400
        # ...and the second attempt changed nothing.
        assert client_no_auth.post(
            "/api/v1/auth/login",
            json={"email": "a@example.com", "password": "new-password"},
        ).status_code == 200

    def test_token_for_a_user_deactivated_since_400(
        self, client_no_auth, db_session
    ):
        user = _make_user(db_session, email="a@example.com", password="old-password")
        token = _issue_token(db_session, user)

        user.active = False
        db_session.commit()

        resp = client_no_auth.post(
            RESET, json={"token": token, "password": "new-password"}
        )
        assert resp.status_code == 400
        db_session.expire_all()
        # The password is untouched, so reactivating the account restores
        # the old login rather than one the requester chose.
        refreshed = db_session.get(User, user.id)
        assert refreshed.password_hash == user.password_hash

    def test_never_401_so_the_frontend_does_not_bounce_to_login(
        self, client_no_auth, db_session
    ):
        """frontend/src/api/client.ts fires onUnauthorized on ANY 401,
        which would replace the reset view with the login form exactly when
        the user needs to read "this link has expired"."""
        resp = client_no_auth.post(
            RESET, json={"token": "stale", "password": "new-password"}
        )
        assert resp.status_code != 401

    def test_short_password_is_rejected(self, client_no_auth, db_session):
        user = _make_user(db_session, email="a@example.com")
        token = _issue_token(db_session, user)
        resp = client_no_auth.post(
            RESET, json={"token": token, "password": "short"}
        )
        assert resp.status_code == 422
        # The token survives a 422 -- the user gets to try again.
        assert len(_tokens_for(db_session, user.id)) == 1

    def test_full_round_trip_from_forgot_to_login(
        self, client_no_auth, db_session, sent_emails
    ):
        _make_user(db_session, email="a@example.com", password="old-password")

        assert client_no_auth.post(
            FORGOT, json={"email": "a@example.com"}
        ).status_code == 204
        url = sent_emails[0][2]
        assert client_no_auth.post(
            RESET,
            json={"token": _reset_token_from_url(url), "password": "brand-new-pw"},
        ).status_code == 204
        assert client_no_auth.post(
            "/api/v1/auth/login",
            json={"email": "a@example.com", "password": "brand-new-pw"},
        ).status_code == 200
