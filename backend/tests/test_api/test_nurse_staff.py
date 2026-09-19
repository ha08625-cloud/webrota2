"""Nurse staff administration: the confinement rules, not the CRUD.

The happy paths here are `/doctors`' own, reached through a second door --
`_doctors.create_doctor_row` and `_doctors.purge_doctor` are shared, and
test_doctors.py already asserts what they do. What this module exists for
is the boundary: that a `nurse_rota`-only login can administer nurses and
*only* nurses, and that a `clinical`-only login cannot administer them
through this router at all.

Six things are asserted that nothing else would catch:

1. `doctor_type` cannot be set on create or changed on patch. No model in
   this codebase sets `extra="forbid"`, so a stray `doctor_type` key is
   silently ignored rather than rejected -- which means the assertion has
   to be on the resulting ROW, never on a 422 that would never come.
2. A non-nurse target is 404, not 403. A 403 would confirm the row exists.
3. The list is nurses only, with a non-nurse present to make that mean
   something.
4. DELETE needs an already-inactive nurse (409 otherwise) and no
   `user_admin` -- the deliberate asymmetry with `DELETE /doctors/{id}`.
5. The `/doctors` asymmetry for a nurse-only login: `GET /doctors` succeeds
   because it is one of the two `deps._SHARED_READ` holes, while
   `GET /doctors/{id}` and every `/doctors` write 403. Surprising, and
   deliberate.
6. Creation satisfies both row invariants -- one SystemCounter per
   SystemCounterType and a unique calendar_token -- asserted here as well
   as in test_doctors.py. The point of sharing `_doctors.py` is that both
   paths have one implementation; this is the test that would fail if that
   ever stopped being true.

`client_with_permissions` is single-use per test and mutually exclusive
with `client` (see conftest), so the fixtures below seed through
`db_session` rather than reusing `seeded`.
"""
import pytest
from sqlalchemy import select

from app.models import Doctor, MasterRotaSession, MasterRotaTemplate, SystemCounter
from app.models.enums import (
    Day,
    DoctorType,
    MasterSessionType,
    Period,
    SystemCounterType,
)
from app.models.permissions import (
    NURSE_ROTA_PRESET,
    WRITE,
    default_permissions,
    preset,
)

NURSES = "/api/v1/nurse-rota/nurses"
DOCTORS = "/api/v1/doctors"


@pytest.fixture
def nurse_client(client_with_permissions):
    """`nurse_rota: write` and nothing else -- the login this feature is
    for, and the one the confinement rules are written against."""
    return client_with_permissions(preset(NURSE_ROTA_PRESET))


@pytest.fixture
def clinical_client(client_with_permissions):
    """`clinical: write`, `nurse_rota: none`. Not a preset: `rota_admin`
    carries both areas, so the only way to test that the nurse router's own
    gate bites is a hand-built set."""
    permissions = default_permissions()
    permissions["clinical"] = WRITE
    return client_with_permissions(permissions)


@pytest.fixture
def staff(db_session):
    """AA (Partner), N1 (active nurse), N2 (inactive nurse), and an active
    template holding one Monday AM session for each nurse.

    N2 is the delete target: inactive already, so it is the one row DELETE
    will accept, and its master session is what the purge has to take with
    it. AA is what makes the 404s and the list filter mean something.
    """
    s = db_session
    aa = Doctor(code="AA", doctor_type=DoctorType.PARTNER, sessions_per_week=10)
    n1 = Doctor(code="N1", doctor_type=DoctorType.NURSE, active=True)
    n2 = Doctor(code="N2", doctor_type=DoctorType.NURSE, active=False)
    s.add_all([aa, n1, n2])
    s.flush()
    template = MasterRotaTemplate(name="Default", is_active=True)
    s.add(template)
    s.flush()
    for nurse, period in ((n1, Period.AM), (n2, Period.PM)):
        s.add(MasterRotaSession(
            template_id=template.id, doctor_id=nurse.id, week=1,
            day=Day.MONDAY, period=period,
            session_type=MasterSessionType.ADMIN_TIME,
        ))
    s.commit()
    return {
        "partner": aa.id, "nurse_active": n1.id, "nurse_inactive": n2.id,
        "template": template.id,
    }


class TestDoctorTypeCannotBeChosen:
    """Rule 3 of the module docstring in routers/nurse_rota.py, both
    halves. Without the PATCH half the 404-unless-nurse guard would be
    worth nothing: a nurse could be promoted out of the partition one
    request later."""

    def test_doctor_type_in_the_create_body_is_ignored(
        self, nurse_client, db_session, staff
    ):
        resp = nurse_client.post(
            NURSES, json={"code": "N3", "doctor_type": "Partner"}
        )
        assert resp.status_code == 201, resp.text
        # On the row, not on a status code: nothing here sets
        # extra="forbid", so the key is ignored rather than rejected and a
        # 422 would never come.
        assert resp.json()["doctor_type"] == "Nurse"
        assert db_session.get(Doctor, resp.json()["id"]).doctor_type is DoctorType.NURSE

    def test_patch_cannot_promote_a_nurse(self, nurse_client, db_session, staff):
        resp = nurse_client.patch(
            f"{NURSES}/{staff['nurse_active']}",
            json={"code": "N1a", "doctor_type": "Partner"},
        )
        # 200, not 422 -- and the code change is what proves the request was
        # honoured rather than quietly discarded whole.
        assert resp.status_code == 200, resp.text
        assert resp.json()["code"] == "N1a"
        assert resp.json()["doctor_type"] == "Nurse"
        db_session.expire_all()
        assert (
            db_session.get(Doctor, staff["nurse_active"]).doctor_type
            is DoctorType.NURSE
        )


class TestNonNurseTargetsAre404:
    """404 and not 403: for a non-nurse this resource does not contain the
    row, and a 403 would say it does."""

    def test_get(self, nurse_client, staff):
        assert nurse_client.get(f"{NURSES}/{staff['partner']}").status_code == 404

    def test_patch(self, nurse_client, db_session, staff):
        resp = nurse_client.patch(
            f"{NURSES}/{staff['partner']}", json={"code": "XX"}
        )
        assert resp.status_code == 404
        db_session.expire_all()
        assert db_session.get(Doctor, staff["partner"]).code == "AA"

    def test_delete(self, nurse_client, db_session, staff):
        assert nurse_client.delete(f"{NURSES}/{staff['partner']}").status_code == 404
        db_session.expire_all()
        assert db_session.get(Doctor, staff["partner"]) is not None

    def test_usage(self, nurse_client, staff):
        # The confirm dialog's input is behind the same guard as the delete
        # it precedes, so it cannot be used to count a doctor's history.
        assert nurse_client.get(
            f"{NURSES}/{staff['partner']}/usage"
        ).status_code == 404


class TestList:
    def test_holds_no_non_nurse_row(self, nurse_client, staff):
        body = nurse_client.get(NURSES).json()
        assert {d["code"] for d in body} == {"N1"}
        assert all(d["doctor_type"] == "Nurse" for d in body)

    def test_include_inactive_adds_the_deactivated_nurse_and_no_doctor(
        self, nurse_client, staff
    ):
        body = nurse_client.get(NURSES, params={"include_inactive": True}).json()
        assert {d["code"] for d in body} == {"N1", "N2"}


class TestCreateInvariants:
    """The two things every doctor row must have at birth. Asserted here as
    well as in test_doctors.py: `_doctors.create_doctor_row` is shared by
    both surfaces precisely so there is one definition, and this is what
    would fail if a second one ever appeared."""

    def test_create_seeds_one_counter_per_type_and_a_unique_token(
        self, nurse_client, db_session, staff
    ):
        ids = []
        for code in ("N3", "N4"):
            resp = nurse_client.post(NURSES, json={"code": code})
            assert resp.status_code == 201, resp.text
            ids.append(resp.json()["id"])

        for doctor_id in ids:
            rows = db_session.execute(
                select(SystemCounter).where(SystemCounter.doctor_id == doctor_id)
            ).scalars().all()
            # generate._write_counters does a strict .scalar_one() per type
            # and 500s the whole generation if this is ever violated.
            assert {r.counter_type for r in rows} == set(SystemCounterType)
            assert all(r.raw_count == 0 for r in rows)

        tokens = [db_session.get(Doctor, i).calendar_token for i in ids]
        assert all(tokens)
        assert tokens[0] != tokens[1]
        assert "calendar_token" not in nurse_client.get(f"{NURSES}/{ids[0]}").json()

    def test_a_code_a_doctor_already_holds_is_a_409_about_staff(
        self, nurse_client, staff
    ):
        """`doctors.code` is unique over the whole table, so a nurse-only
        login meets this the moment it picks a code a doctor holds. Nothing
        is concealed -- `GET /doctors` is shared-read for every login -- so
        the only thing that differs from `/doctors`' own 409 is the noun."""
        resp = nurse_client.post(NURSES, json={"code": "AA"})
        assert resp.status_code == 409, resp.text
        assert resp.json()["detail"] == "Staff code 'AA' is already in use"


class TestDelete:
    """No `user_admin` dependency, deliberately: this is the first
    permanent staff purge in the API without one, and the login it widens is
    `rota_admin` as much as the nurse-only one. The deactivate-first 409 is
    one of the three mitigations that stay."""

    def test_an_active_nurse_is_409(self, nurse_client, db_session, staff):
        resp = nurse_client.delete(f"{NURSES}/{staff['nurse_active']}")
        assert resp.status_code == 409, resp.text
        assert "deactivate" in resp.json()["detail"]
        db_session.expire_all()
        assert db_session.get(Doctor, staff["nurse_active"]) is not None

    def test_an_inactive_nurse_is_purged_with_its_master_sessions(
        self, nurse_client, db_session, staff
    ):
        nurse_id = staff["nurse_inactive"]
        resp = nurse_client.delete(f"{NURSES}/{nurse_id}")
        assert resp.status_code == 200, resp.text
        assert resp.json()["deleted"]["master_rota_sessions"] == 1

        db_session.expire_all()
        assert db_session.get(Doctor, nurse_id) is None
        assert db_session.execute(
            select(MasterRotaSession).where(MasterRotaSession.doctor_id == nurse_id)
        ).scalars().first() is None
        # The other nurse's session is untouched -- the purge is one row's.
        assert db_session.execute(
            select(MasterRotaSession).where(
                MasterRotaSession.doctor_id == staff["nurse_active"]
            )
        ).scalars().first() is not None


class TestANurseLoginCannotAdministerDoctors:
    """The asymmetry in full. `GET /doctors` is one of the two entries in
    `deps._SHARED_READ`, open to every authenticated login for the
    user-admin linked-doctor picker -- so it succeeds here while everything
    else on that router 403s. That is surprising enough to be worth
    asserting in both directions in one place."""

    def test_the_shared_read_list_still_succeeds(self, nurse_client, staff):
        resp = nurse_client.get(DOCTORS)
        assert resp.status_code == 200, resp.text
        assert {d["code"] for d in resp.json()} >= {"AA", "N1"}

    def test_but_one_doctor_by_id_is_403(self, nurse_client, staff):
        # Not in _SHARED_READ: the hole is the list, not the router.
        assert nurse_client.get(f"{DOCTORS}/{staff['partner']}").status_code == 403

    def test_every_doctors_write_is_403(self, nurse_client, db_session, staff):
        assert nurse_client.post(
            DOCTORS, json={"code": "ZZ", "doctor_type": "Partner"}
        ).status_code == 403
        assert nurse_client.patch(
            f"{DOCTORS}/{staff['nurse_active']}", json={"code": "ZZ"}
        ).status_code == 403
        assert nurse_client.delete(
            f"{DOCTORS}/{staff['nurse_inactive']}"
        ).status_code == 403
        db_session.expire_all()
        assert db_session.get(Doctor, staff["nurse_inactive"]) is not None


class TestAClinicalLoginCannotUseTheNurseRouter:
    """The mirror. `clinical: write` is the superset in substance -- it can
    do all of this through `/doctors` -- but not through this router, whose
    gate is resolved per router at `include_router` time."""

    def test_every_nurse_staff_route_is_403(self, clinical_client, staff):
        assert clinical_client.get(NURSES).status_code == 403
        assert clinical_client.get(
            f"{NURSES}/{staff['nurse_active']}"
        ).status_code == 403
        assert clinical_client.get(
            f"{NURSES}/{staff['nurse_active']}/usage"
        ).status_code == 403
        assert clinical_client.post(NURSES, json={"code": "N3"}).status_code == 403
        assert clinical_client.patch(
            f"{NURSES}/{staff['nurse_active']}", json={"code": "N9"}
        ).status_code == 403
        assert clinical_client.delete(
            f"{NURSES}/{staff['nurse_inactive']}"
        ).status_code == 403

    def test_and_is_unaffected_on_doctors(self, clinical_client, db_session, staff):
        """The same rows, through the clinical surface, which remains the
        full staff surface -- nurses included."""
        assert clinical_client.get(
            f"{DOCTORS}/{staff['nurse_active']}"
        ).status_code == 200
        resp = clinical_client.patch(
            f"{DOCTORS}/{staff['nurse_active']}", json={"code": "N1a"}
        )
        assert resp.status_code == 200, resp.text
        db_session.expire_all()
        assert db_session.get(Doctor, staff["nurse_active"]).code == "N1a"
