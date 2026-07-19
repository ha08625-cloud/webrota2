"""User management tests (auth plan, Task 4).

CRUD happy paths use `client` (the overridden-auth fixture every other test
file relies on) since the users router itself doesn't care who is calling --
there is no admin tier. `client_no_auth` is used only where a real login
session actually needs to exist and be checked (the password-reset
session-invalidation test).
"""
import datetime

from sqlalchemy import func, select

from app.api.auth_utils import hash_token, new_session_token
from app.models import User, UserSession

USERS = "/api/v1/users"


def _session_count(db_session, user_id):
    return db_session.execute(
        select(func.count()).select_from(UserSession).where(UserSession.user_id == user_id)
    ).scalar_one()


def _create_user(client, email="a@example.com", name="A User", password="password123"):
    resp = client.post(USERS, json={"email": email, "name": name, "password": password})
    assert resp.status_code == 201, resp.text
    return resp.json()


class TestCrudHappyPaths:
    def test_create_then_list(self, client):
        created = _create_user(client)
        resp = client.get(USERS)
        assert resp.status_code == 200
        emails = [u["email"] for u in resp.json()]
        assert created["email"] in emails

    def test_create_response_has_no_password_hash(self, client):
        created = _create_user(client)
        assert "password_hash" not in created
        assert "password" not in created

    def test_list_response_has_no_password_hash(self, client):
        _create_user(client)
        resp = client.get(USERS)
        for user in resp.json():
            assert "password_hash" not in user
            assert "password" not in user

    def test_patch_name_and_email(self, client):
        created = _create_user(client)
        resp = client.patch(
            f"{USERS}/{created['id']}",
            json={"name": "New Name", "email": "new@example.com"},
        )
        assert resp.status_code == 200, resp.text
        body = resp.json()
        assert body["name"] == "New Name"
        assert body["email"] == "new@example.com"
        assert "password_hash" not in body

    def test_duplicate_email_409(self, client):
        _create_user(client, email="dupe@example.com")
        resp = client.post(
            USERS,
            json={"email": "dupe@example.com", "name": "Someone Else", "password": "password123"},
        )
        assert resp.status_code == 409

    def test_patch_to_duplicate_email_409(self, client):
        _create_user(client, email="first@example.com")
        second = _create_user(client, email="second@example.com")
        resp = client.patch(
            f"{USERS}/{second['id']}", json={"email": "first@example.com"}
        )
        assert resp.status_code == 409

    def test_patch_unknown_user_404(self, client):
        resp = client.patch(f"{USERS}/999999", json={"name": "Nobody"})
        assert resp.status_code == 404


class TestPasswordReset:
    def test_password_reset_rehashes_and_invalidates_sessions(
        self, client, client_no_auth, db_session
    ):
        # Create the user and log them in for real, via the no-auth client,
        # so there is an actual session row to invalidate.
        created = _create_user(client, email="reset@example.com", password="old-password")
        login = client_no_auth.post(
            "/api/v1/auth/login",
            json={"email": "reset@example.com", "password": "old-password"},
        )
        assert login.status_code == 200, login.text
        old_token = login.json()["token"]
        assert client_no_auth.get(
            "/api/v1/rooms", headers={"Authorization": f"Bearer {old_token}"}
        ).status_code == 200

        resp = client.patch(
            f"{USERS}/{created['id']}", json={"password": "new-password"}
        )
        assert resp.status_code == 200, resp.text
        assert "password_hash" not in resp.json()

        # Old token is dead.
        assert client_no_auth.get(
            "/api/v1/rooms", headers={"Authorization": f"Bearer {old_token}"}
        ).status_code == 401

        # New password logs in fine.
        relogin = client_no_auth.post(
            "/api/v1/auth/login",
            json={"email": "reset@example.com", "password": "new-password"},
        )
        assert relogin.status_code == 200, relogin.text

        # Old password no longer works.
        old_login = client_no_auth.post(
            "/api/v1/auth/login",
            json={"email": "reset@example.com", "password": "old-password"},
        )
        assert old_login.status_code == 401

    def test_password_reset_deletes_all_sessions_for_target(self, client, db_session):
        created = _create_user(client, email="multi@example.com", password="old-password")
        user = db_session.get(User, created["id"])
        now = datetime.datetime.now(datetime.timezone.utc)
        for _ in range(3):
            db_session.add(UserSession(
                token_hash=hash_token(new_session_token()),
                user_id=user.id,
                created_at=now,
                expires_at=now + datetime.timedelta(days=30),
            ))
        db_session.commit()
        assert _session_count(db_session, user.id) == 3

        resp = client.patch(f"{USERS}/{created['id']}", json={"password": "new-password"})
        assert resp.status_code == 200, resp.text

        db_session.expire_all()
        assert _session_count(db_session, user.id) == 0

    def test_patch_without_password_leaves_sessions_alone(self, client, db_session):
        created = _create_user(client, email="untouched@example.com")
        user = db_session.get(User, created["id"])
        now = datetime.datetime.now(datetime.timezone.utc)
        db_session.add(UserSession(
            token_hash=hash_token(new_session_token()),
            user_id=user.id, created_at=now, expires_at=now + datetime.timedelta(days=30),
        ))
        db_session.commit()

        resp = client.patch(f"{USERS}/{created['id']}", json={"name": "Renamed"})
        assert resp.status_code == 200, resp.text

        db_session.expire_all()
        assert _session_count(db_session, user.id) == 1


class TestLockOutGuard:
    def test_deactivating_the_last_active_user_409s(self, client):
        created = _create_user(client, email="only@example.com")
        resp = client.patch(f"{USERS}/{created['id']}", json={"active": False})
        assert resp.status_code == 409

    def test_deactivating_a_non_last_user_succeeds(self, client):
        first = _create_user(client, email="first@example.com")
        _create_user(client, email="second@example.com")
        resp = client.patch(f"{USERS}/{first['id']}", json={"active": False})
        assert resp.status_code == 200, resp.text
        assert resp.json()["active"] is False

    def test_deactivating_an_already_inactive_user_is_not_blocked_by_guard(self, client):
        first = _create_user(client, email="first@example.com")
        second = _create_user(client, email="second@example.com")
        assert client.patch(
            f"{USERS}/{second['id']}", json={"active": False}
        ).status_code == 200

        # second is already inactive; patching it again with active=False
        # is a no-op from the guard's point of view, not a second
        # last-user deactivation -- first is still the sole active user.
        resp = client.patch(f"{USERS}/{second['id']}", json={"active": False})
        assert resp.status_code == 200, resp.text

    def test_reactivating_then_deactivating_the_original_still_guards(self, client):
        first = _create_user(client, email="first@example.com")
        second = _create_user(client, email="second@example.com")
        assert client.patch(
            f"{USERS}/{second['id']}", json={"active": False}
        ).status_code == 200
        # Only `first` is active now -- deactivating it should 409.
        resp = client.patch(f"{USERS}/{first['id']}", json={"active": False})
        assert resp.status_code == 409