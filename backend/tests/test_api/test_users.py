"""User management tests (auth plan, Task 4; role-based auth, Task 2).

CRUD happy paths use `client`, whose stub user is a MANAGER -- the tier
every one of these endpoints now requires. Tier enforcement itself
(non-managers 403ing on /users) lives in test_authorization.py alongside
the rest of the gating; what is tested here is the behaviour of the
endpoints once you are allowed through: the lock-out guard and
/users/me.

The /users/me tests run through `client_no_auth` and real logins rather
than the stub. PATCH /users/me is the one endpoint that looks its own
caller up in the database, and its password path deletes the caller's
sessions -- neither is observable against a stub user that was never
persisted.

`client` and `client_no_auth` are never combined in the same test.
app.dependency_overrides is a single dict on the shared `app` object,
checked at request time -- not captured per-fixture-instance -- so
whichever fixture's setup ran last decides the override in effect for
EVERY request made through EITHER TestClient for the rest of that test,
including calls through the other one. There is no ordering of the two
fixtures that fixes this; they are mutually exclusive within one test.
test_password_reset_rehashes_and_invalidates_sessions needs a real login
session to invalidate, so it uses client_no_auth exclusively: it seeds the
first user directly via db_session (there is no bootstrap endpoint by
design -- POST /users itself requires auth) and does everything else,
including creating the target user, through real Bearer tokens obtained
from real /auth/login calls.
"""
import datetime

from sqlalchemy import func, select

import pytest

from app.api.auth_utils import hash_password, hash_token, new_session_token
from app.models import Doctor, ReceptionStaff, User, UserSession
from app.models.enums import AccessLevel, DoctorType

USERS = "/api/v1/users"


def _session_count(db_session, user_id):
    return db_session.execute(
        select(func.count()).select_from(UserSession).where(UserSession.user_id == user_id)
    ).scalar_one()


def _create_user(
    client,
    email="a@example.com",
    name="A User",
    password="password123",
    access_level="manager",
):
    resp = client.post(USERS, json={
        "email": email, "name": name, "password": password,
        "access_level": access_level,
    })
    assert resp.status_code == 201, resp.text
    return resp.json()


def _seed_user_directly(
    db_session, email, password, active=True, access_level=AccessLevel.MANAGER
):
    """Insert a user row without going through the API -- used only to
    bootstrap the first real login session a test needs, since POST
    /users itself requires an existing authenticated user. Defaults
    to MANAGER, matching what
    seed/seed_users.py creates."""
    user = User(
        email=email,
        name="Seeded User",
        password_hash=hash_password(password),
        active=active,
        access_level=access_level,
        created_at=datetime.datetime.now(datetime.timezone.utc),
    )
    db_session.add(user)
    db_session.commit()
    db_session.refresh(user)
    return user


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
            json={
                "email": "dupe@example.com", "name": "Someone Else",
                "password": "password123", "access_level": "admin",
            },
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


class TestAccessLevel:
    """Role-based auth plan, Task 1: the column is carried end to end.
    Nothing is enforced yet -- that is Task 2."""

    @pytest.mark.parametrize("level", ["manager", "admin", "doctor", "nurse"])
    def test_create_persists_and_returns_access_level(
        self, client, db_session, level
    ):
        created = _create_user(
            client, email=f"{level}@example.com", access_level=level
        )
        assert created["access_level"] == level
        assert db_session.get(User, created["id"]).access_level == AccessLevel(level)

    def test_create_without_access_level_422s(self, client):
        resp = client.post(USERS, json={
            "email": "no-level@example.com", "name": "No Level",
            "password": "password123",
        })
        assert resp.status_code == 422

    def test_create_with_unknown_access_level_422s(self, client):
        resp = client.post(USERS, json={
            "email": "bogus@example.com", "name": "Bogus",
            "password": "password123", "access_level": "superuser",
        })
        assert resp.status_code == 422

    def test_patch_changes_access_level(self, client, db_session):
        created = _create_user(client, email="promote@example.com", access_level="nurse")
        resp = client.patch(
            f"{USERS}/{created['id']}", json={"access_level": "admin"}
        )
        assert resp.status_code == 200, resp.text
        assert resp.json()["access_level"] == "admin"
        db_session.expire_all()
        assert db_session.get(User, created["id"]).access_level == AccessLevel.ADMIN

    def test_patch_leaves_access_level_alone_when_unset(self, client, db_session):
        created = _create_user(client, email="keep@example.com", access_level="admin")
        resp = client.patch(f"{USERS}/{created['id']}", json={"name": "Renamed"})
        assert resp.status_code == 200, resp.text
        assert resp.json()["access_level"] == "admin"

    def test_list_includes_access_level(self, client):
        _create_user(client, email="listed@example.com", access_level="doctor")
        resp = client.get(USERS)
        assert resp.status_code == 200
        levels = {u["email"]: u["access_level"] for u in resp.json()}
        assert levels["listed@example.com"] == "doctor"


class TestPasswordReset:
    def test_password_reset_rehashes_and_invalidates_sessions(
        self, client_no_auth, db_session
    ):
        # Bootstrap: seed an "admin" user directly and log them in for a
        # real token, since POST /users requires auth and client is off
        # limits here (see module docstring).
        _seed_user_directly(db_session, "admin@example.com", "admin-password")
        admin_login = client_no_auth.post(
            "/api/v1/auth/login",
            json={"email": "admin@example.com", "password": "admin-password"},
        )
        assert admin_login.status_code == 200, admin_login.text
        admin_headers = {"Authorization": f"Bearer {admin_login.json()['token']}"}

        # Create the target user through the real API, as the admin.
        create_resp = client_no_auth.post(
            USERS,
            headers=admin_headers,
            json={
                "email": "reset@example.com", "name": "Reset Target",
                "password": "old-password", "access_level": "doctor",
            },
        )
        assert create_resp.status_code == 201, create_resp.text
        target_id = create_resp.json()["id"]

        # Log the target in for real, so there is an actual session row
        # to invalidate.
        target_login = client_no_auth.post(
            "/api/v1/auth/login",
            json={"email": "reset@example.com", "password": "old-password"},
        )
        assert target_login.status_code == 200, target_login.text
        old_token = target_login.json()["token"]
        assert client_no_auth.get(
            "/api/v1/rooms", headers={"Authorization": f"Bearer {old_token}"}
        ).status_code == 200

        resp = client_no_auth.patch(
            f"{USERS}/{target_id}", headers=admin_headers, json={"password": "new-password"}
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
    """The guard counts active MANAGERS, not active users. Both
    routes to zero of them -- deactivation and
    demotion -- are blocked, because guarding only the first would leave an
    identical lock-out one PATCH away."""

    def test_deactivating_the_last_active_manager_409s(self, client):
        created = _create_user(client, email="only@example.com")
        resp = client.patch(f"{USERS}/{created['id']}", json={"active": False})
        assert resp.status_code == 409

    def test_deactivating_a_non_last_manager_succeeds(self, client):
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
        # last-manager deactivation -- first is still the sole active
        # manager.
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

    def test_other_active_non_managers_do_not_satisfy_the_guard(self, client):
        """The case the old active-user count got wrong: plenty of active
        users left, none of whom can administer anything."""
        manager = _create_user(client, email="mgr@example.com", access_level="manager")
        _create_user(client, email="adm@example.com", access_level="admin")
        _create_user(client, email="doc@example.com", access_level="doctor")
        resp = client.patch(f"{USERS}/{manager['id']}", json={"active": False})
        assert resp.status_code == 409

    def test_demoting_the_last_active_manager_409s(self, client):
        manager = _create_user(client, email="mgr@example.com", access_level="manager")
        _create_user(client, email="adm@example.com", access_level="admin")
        resp = client.patch(
            f"{USERS}/{manager['id']}", json={"access_level": "admin"}
        )
        assert resp.status_code == 409

    def test_demoting_a_non_last_manager_succeeds(self, client, db_session):
        first = _create_user(client, email="mgr1@example.com", access_level="manager")
        _create_user(client, email="mgr2@example.com", access_level="manager")
        resp = client.patch(
            f"{USERS}/{first['id']}", json={"access_level": "nurse"}
        )
        assert resp.status_code == 200, resp.text
        assert resp.json()["access_level"] == "nurse"
        db_session.expire_all()
        assert db_session.get(User, first["id"]).access_level == AccessLevel.NURSE

    def test_demoting_an_inactive_manager_is_not_blocked(self, client):
        """An inactive manager is not propping anything up, so demoting one
        is not a lock-out even when they are the only manager left."""
        _create_user(client, email="keeper@example.com")
        spare = _create_user(client, email="spare@example.com")
        assert client.patch(
            f"{USERS}/{spare['id']}", json={"active": False}
        ).status_code == 200
        # keeper is the sole ACTIVE manager; spare is inactive.
        resp = client.patch(f"{USERS}/{spare['id']}", json={"access_level": "nurse"})
        assert resp.status_code == 200, resp.text

    def test_promoting_is_never_blocked(self, client):
        nurse = _create_user(client, email="nurse@example.com", access_level="nurse")
        resp = client.patch(
            f"{USERS}/{nurse['id']}", json={"access_level": "manager"}
        )
        assert resp.status_code == 200, resp.text
        assert resp.json()["access_level"] == "manager"

    def test_deactivate_and_demote_in_one_patch_is_still_guarded(self, client):
        manager = _create_user(client, email="mgr@example.com")
        resp = client.patch(
            f"{USERS}/{manager['id']}",
            json={"active": False, "access_level": "nurse"},
        )
        assert resp.status_code == 409


class TestPatchMe:
    """PATCH /users/me: the one write on this router open to every tier.

    Run against real logins rather than the stub user -- the endpoint
    fetches its own row and deletes its own sessions, neither of which a
    non-persisted stub can show.
    """

    def _login(self, client, email, password):
        resp = client.post(
            "/api/v1/auth/login", json={"email": email, "password": password}
        )
        assert resp.status_code == 200, resp.text
        return resp.json()["token"]

    def _nurse(self, client_no_auth, db_session):
        _seed_user_directly(
            db_session, "nurse@example.com", "old-password",
            access_level=AccessLevel.NURSE,
        )
        token = self._login(client_no_auth, "nurse@example.com", "old-password")
        return {"Authorization": f"Bearer {token}"}

    def test_viewer_can_rename_themselves(self, client_no_auth, db_session):
        headers = self._nurse(client_no_auth, db_session)
        resp = client_no_auth.patch(
            f"{USERS}/me", headers=headers, json={"name": "Renamed"}
        )
        assert resp.status_code == 200, resp.text
        assert resp.json()["name"] == "Renamed"
        assert resp.json()["access_level"] == "nurse"
        assert "password_hash" not in resp.json()

    def test_me_wins_the_route_match_over_user_id(self, client_no_auth, db_session):
        """PATCH /users/me is declared above PATCH /{user_id}; if that
        ordering were reversed this would 422 on int("me")."""
        headers = self._nurse(client_no_auth, db_session)
        resp = client_no_auth.patch(
            f"{USERS}/me", headers=headers, json={"name": "Renamed"}
        )
        assert resp.status_code == 200, resp.text

    def test_password_change_signs_the_caller_out_everywhere(
        self, client_no_auth, db_session
    ):
        headers = self._nurse(client_no_auth, db_session)
        assert client_no_auth.get(
            "/api/v1/rooms", headers=headers
        ).status_code == 200

        resp = client_no_auth.patch(
            f"{USERS}/me", headers=headers, json={"password": "new-password"}
        )
        assert resp.status_code == 200, resp.text

        # The caller's own token is among the sessions deleted -- a
        # password change logs you out everywhere, this session included.
        assert client_no_auth.get(
            "/api/v1/rooms", headers=headers
        ).status_code == 401
        assert self._login(client_no_auth, "nurse@example.com", "new-password")
        assert client_no_auth.post(
            "/api/v1/auth/login",
            json={"email": "nurse@example.com", "password": "old-password"},
        ).status_code == 401

    def test_cannot_self_promote(self, client_no_auth, db_session):
        headers = self._nurse(client_no_auth, db_session)
        resp = client_no_auth.patch(
            f"{USERS}/me", headers=headers,
            json={"name": "Sneaky", "access_level": "manager"},
        )
        # UserSelfPatch has no access_level field, so pydantic drops the key
        # rather than 422ing. The name change lands; the promotion does not.
        assert resp.status_code == 200, resp.text
        assert resp.json()["name"] == "Sneaky"
        assert resp.json()["access_level"] == "nurse"
        db_session.expire_all()
        seeded_row = db_session.execute(
            select(User).where(User.email == "nurse@example.com")
        ).scalar_one()
        assert seeded_row.access_level == AccessLevel.NURSE

    def test_cannot_change_own_email_or_active_flag(self, client_no_auth, db_session):
        headers = self._nurse(client_no_auth, db_session)
        resp = client_no_auth.patch(
            f"{USERS}/me", headers=headers,
            json={"email": "elsewhere@example.com", "active": False},
        )
        assert resp.status_code == 200, resp.text
        assert resp.json()["email"] == "nurse@example.com"
        assert resp.json()["active"] is True

    def test_empty_patch_is_a_no_op(self, client_no_auth, db_session):
        headers = self._nurse(client_no_auth, db_session)
        resp = client_no_auth.patch(f"{USERS}/me", headers=headers, json={})
        assert resp.status_code == 200, resp.text
        assert resp.json()["email"] == "nurse@example.com"
        # Sessions untouched: the token still works.
        assert client_no_auth.get(
            "/api/v1/rooms", headers=headers
        ).status_code == 200

    def test_short_password_is_rejected(self, client_no_auth, db_session):
        headers = self._nurse(client_no_auth, db_session)
        resp = client_no_auth.patch(
            f"{USERS}/me", headers=headers, json={"password": "short"}
        )
        assert resp.status_code == 422

    def test_manager_can_also_use_it(self, client_no_auth, db_session):
        _seed_user_directly(db_session, "mgr@example.com", "old-password")
        token = self._login(client_no_auth, "mgr@example.com", "old-password")
        resp = client_no_auth.patch(
            f"{USERS}/me",
            headers={"Authorization": f"Bearer {token}"},
            json={"name": "The Manager"},
        )
        assert resp.status_code == 200, resp.text
        assert resp.json()["name"] == "The Manager"

    def test_requires_authentication(self, client_no_auth):
        assert client_no_auth.patch(f"{USERS}/me", json={"name": "X"}).status_code == 401


class TestStaffLinks:
    """The optional link from a login to a rota person (models/user.py).

    The link is orthogonal to access_level in both directions -- setting one
    never moves the other -- and two of the tests below exist only to pin
    that, because it is the property most likely to be quietly "helpfully"
    fudged by a later change.
    """

    def _doctor(self, db_session, code="AB", active=True):
        doctor = Doctor(
            code=code,
            doctor_type=DoctorType.PARTNER,
            sessions_per_week=10,
            active=active,
        )
        db_session.add(doctor)
        db_session.commit()
        db_session.refresh(doctor)
        return doctor

    def _staff(self, db_session, code="Emily M"):
        staff = ReceptionStaff(code=code, active=True)
        db_session.add(staff)
        db_session.commit()
        db_session.refresh(staff)
        return staff

    def test_create_with_links(self, client, db_session):
        doctor = self._doctor(db_session)
        staff = self._staff(db_session)
        resp = client.post(USERS, json={
            "email": "linked@example.com", "name": "Linked",
            "password": "password123", "access_level": "doctor",
            "doctor_id": doctor.id, "reception_staff_id": staff.id,
        })
        assert resp.status_code == 201, resp.text
        body = resp.json()
        assert body["linked_doctor"] == {
            "id": doctor.id, "code": "AB", "active": True
        }
        assert body["linked_reception_staff"]["code"] == "Emily M"
        row = db_session.get(User, body["id"])
        assert (row.doctor_id, row.reception_staff_id) == (doctor.id, staff.id)

    def test_create_without_links_is_unlinked(self, client):
        created = _create_user(client, email="plain@example.com")
        assert created["linked_doctor"] is None
        assert created["linked_reception_staff"] is None

    def test_create_with_unknown_doctor_404s(self, client):
        resp = client.post(USERS, json={
            "email": "ghost@example.com", "name": "Ghost",
            "password": "password123", "access_level": "doctor",
            "doctor_id": 999999,
        })
        assert resp.status_code == 404, resp.text

    def test_create_with_unknown_reception_staff_404s(self, client):
        resp = client.post(USERS, json={
            "email": "ghost2@example.com", "name": "Ghost",
            "password": "password123", "access_level": "nurse",
            "reception_staff_id": 999999,
        })
        assert resp.status_code == 404, resp.text

    def test_create_with_claimed_doctor_409s(self, client, db_session):
        doctor = self._doctor(db_session)
        _create_user(client, email="first@example.com")
        assert client.patch(
            f"{USERS}/{_create_user(client, email='holder@example.com')['id']}",
            json={"doctor_id": doctor.id},
        ).status_code == 200
        resp = client.post(USERS, json={
            "email": "second@example.com", "name": "Second",
            "password": "password123", "access_level": "doctor",
            "doctor_id": doctor.id,
        })
        assert resp.status_code == 409, resp.text

    def test_patch_sets_changes_and_clears_the_link(self, client, db_session):
        first = self._doctor(db_session, code="AB")
        second = self._doctor(db_session, code="CD")
        created = _create_user(client, email="mover@example.com")

        resp = client.patch(f"{USERS}/{created['id']}", json={"doctor_id": first.id})
        assert resp.status_code == 200, resp.text
        assert resp.json()["linked_doctor"]["code"] == "AB"

        resp = client.patch(f"{USERS}/{created['id']}", json={"doctor_id": second.id})
        assert resp.status_code == 200, resp.text
        assert resp.json()["linked_doctor"]["code"] == "CD"

        resp = client.patch(f"{USERS}/{created['id']}", json={"doctor_id": None})
        assert resp.status_code == 200, resp.text
        assert resp.json()["linked_doctor"] is None
        db_session.expire_all()
        assert db_session.get(User, created["id"]).doctor_id is None

    def test_repatching_the_same_link_is_not_a_self_conflict(self, client, db_session):
        """Re-saving an unchanged form must not 409 against the user's own
        row -- the claimed-by-another check excludes the patch target."""
        doctor = self._doctor(db_session)
        created = _create_user(client, email="resave@example.com")
        for _ in range(2):
            resp = client.patch(
                f"{USERS}/{created['id']}", json={"doctor_id": doctor.id}
            )
            assert resp.status_code == 200, resp.text

    def test_patch_to_a_claimed_doctor_409s(self, client, db_session):
        doctor = self._doctor(db_session)
        holder = _create_user(client, email="holder@example.com")
        other = _create_user(client, email="other@example.com")
        assert client.patch(
            f"{USERS}/{holder['id']}", json={"doctor_id": doctor.id}
        ).status_code == 200
        resp = client.patch(f"{USERS}/{other['id']}", json={"doctor_id": doctor.id})
        assert resp.status_code == 409, resp.text
        assert "already exists" not in resp.json()["detail"]

    def test_patch_to_an_unknown_doctor_404s(self, client):
        created = _create_user(client, email="nowhere@example.com")
        resp = client.patch(f"{USERS}/{created['id']}", json={"doctor_id": 999999})
        assert resp.status_code == 404, resp.text

    def test_unrelated_patch_leaves_the_link_alone(self, client, db_session):
        doctor = self._doctor(db_session)
        created = _create_user(client, email="rename@example.com")
        assert client.patch(
            f"{USERS}/{created['id']}", json={"doctor_id": doctor.id}
        ).status_code == 200
        resp = client.patch(f"{USERS}/{created['id']}", json={"name": "Renamed"})
        assert resp.status_code == 200, resp.text
        assert resp.json()["linked_doctor"]["id"] == doctor.id

    def test_patching_access_level_leaves_the_link_alone(self, client, db_session):
        """D3: neither derives the other."""
        doctor = self._doctor(db_session)
        created = _create_user(client, email="tier@example.com", access_level="manager")
        _create_user(client, email="spare-manager@example.com")
        assert client.patch(
            f"{USERS}/{created['id']}", json={"doctor_id": doctor.id}
        ).status_code == 200
        resp = client.patch(f"{USERS}/{created['id']}", json={"access_level": "nurse"})
        assert resp.status_code == 200, resp.text
        assert resp.json()["access_level"] == "nurse"
        assert resp.json()["linked_doctor"]["id"] == doctor.id

    def test_linking_does_not_change_access_level(self, client, db_session):
        """D3, the other direction: a doctor link is not the DOCTOR tier."""
        doctor = self._doctor(db_session)
        created = _create_user(client, email="nurse-link@example.com", access_level="nurse")
        resp = client.patch(f"{USERS}/{created['id']}", json={"doctor_id": doctor.id})
        assert resp.status_code == 200, resp.text
        assert resp.json()["access_level"] == "nurse"
        db_session.expire_all()
        assert db_session.get(User, created["id"]).access_level == AccessLevel.NURSE

    def test_list_carries_links_and_nulls(self, client, db_session):
        doctor = self._doctor(db_session)
        linked = _create_user(client, email="listed-linked@example.com")
        _create_user(client, email="listed-plain@example.com")
        assert client.patch(
            f"{USERS}/{linked['id']}", json={"doctor_id": doctor.id}
        ).status_code == 200

        resp = client.get(USERS)
        assert resp.status_code == 200, resp.text
        by_email = {u["email"]: u for u in resp.json()}
        assert by_email["listed-linked@example.com"]["linked_doctor"]["code"] == "AB"
        assert by_email["listed-plain@example.com"]["linked_doctor"] is None

    def test_link_to_an_inactive_doctor_serialises_as_inactive(
        self, client, db_session
    ):
        """D4: a soft-deleted doctor never clears the link -- it is shown as
        inactive instead, so the record of whose login it is survives."""
        doctor = self._doctor(db_session)
        created = _create_user(client, email="retired@example.com")
        assert client.patch(
            f"{USERS}/{created['id']}", json={"doctor_id": doctor.id}
        ).status_code == 200
        doctor.active = False
        db_session.commit()

        resp = client.get(USERS)
        by_email = {u["email"]: u for u in resp.json()}
        link = by_email["retired@example.com"]["linked_doctor"]
        assert link["id"] == doctor.id
        assert link["active"] is False

    def test_patch_me_cannot_self_link(self, client_no_auth, db_session):
        """UserSelfPatch has no doctor_id, so the key is dropped rather than
        422ing -- the same shape as the access-level test above."""
        doctor = self._doctor(db_session)
        _seed_user_directly(
            db_session, "selflink@example.com", "old-password",
            access_level=AccessLevel.NURSE,
        )
        login = client_no_auth.post(
            "/api/v1/auth/login",
            json={"email": "selflink@example.com", "password": "old-password"},
        )
        assert login.status_code == 200, login.text
        headers = {"Authorization": f"Bearer {login.json()['token']}"}

        resp = client_no_auth.patch(
            f"{USERS}/me", headers=headers,
            json={"name": "Sneaky", "doctor_id": doctor.id},
        )
        assert resp.status_code == 200, resp.text
        assert resp.json()["name"] == "Sneaky"
        assert resp.json()["linked_doctor"] is None
        db_session.expire_all()
        row = db_session.execute(
            select(User).where(User.email == "selflink@example.com")
        ).scalar_one()
        assert row.doctor_id is None
