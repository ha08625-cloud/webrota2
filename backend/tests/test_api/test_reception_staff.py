"""Reception staff router tests (reception rota, Task 2).

DELETE is a permanent purge, not a soft delete -- the deactivate half lives
in TestReceptionStaff via PATCH, and everything destructive is in
TestPermanentDelete below.
"""
import datetime

from app.api.routers.reception_staff import NULLED_TABLES, PURGED_MODELS
from app.database import Base
from app.models import (
    ReceptionLeaveEntry,
    ReceptionMasterSession,
    ReceptionRota,
    ReceptionRotaSession,
    ReceptionStaff,
    User,
)
from app.models.enums import Day, ReceptionRole

STAFF = "/api/v1/reception/staff"

DAY_ONE = datetime.date(2026, 3, 2)
DAY_TWO = datetime.date(2026, 3, 3)


def _seed_history(db, staff_ids, dates=(DAY_ONE, DAY_TWO)):
    """Master template slots, generated-day rows on `dates`, and one leave
    entry per date, for every staff id given. Written straight to the DB
    rather than through the generate endpoint: these tests care about which
    rows survive a delete, not about how they came to exist."""
    for date in dates:
        rota = ReceptionRota(date=date)
        db.add(rota)
        db.flush()
        for staff_id in staff_ids:
            db.add(ReceptionRotaSession(
                rota_id=rota.id, staff_id=staff_id, hour=9.0,
                role=ReceptionRole.PHONES,
            ))
    for staff_id in staff_ids:
        db.add(ReceptionMasterSession(
            staff_id=staff_id, day=Day.MONDAY, hour=9.0,
            role=ReceptionRole.PHONES,
        ))
        db.add(ReceptionMasterSession(
            staff_id=staff_id, day=Day.TUESDAY, hour=9.0,
            role=ReceptionRole.PHONES,
        ))
        for date in dates:
            db.add(ReceptionLeaveEntry(staff_id=staff_id, date=date))
    db.commit()


def _deactivate(client, staff_id):
    resp = client.patch(f"{STAFF}/{staff_id}", json={"active": False})
    assert resp.status_code == 200, resp.text


def _rows_for(db, model, staff_id):
    return db.query(model).filter(model.staff_id == staff_id).all()


class TestReceptionStaff:
    def test_create_and_list(self, client, seeded_reception):
        resp = client.post(STAFF, json={"code": "RE"})
        assert resp.status_code == 201
        body = resp.json()
        assert body["code"] == "RE"
        assert body["active"] is True

        listed = client.get(STAFF).json()
        assert {s["code"] for s in listed} == {"RA", "RB", "RC", "RE"}

    def test_duplicate_code_409(self, client, seeded_reception):
        resp = client.post(STAFF, json={"code": "RA"})
        assert resp.status_code == 409

    def test_patch_code(self, client, seeded_reception):
        url = f"{STAFF}/{seeded_reception['staff_ra']}"
        resp = client.patch(url, json={"code": "Alice Updated"})
        assert resp.status_code == 200
        assert resp.json()["code"] == "Alice Updated"

    def test_patch_duplicate_code_409(self, client, seeded_reception):
        url = f"{STAFF}/{seeded_reception['staff_ra']}"
        resp = client.patch(url, json={"code": "RB"})
        assert resp.status_code == 409

    def test_patch_deactivates_then_list(self, client, seeded_reception):
        """Deactivation is PATCH, not DELETE -- the row stays, and only the
        include_inactive list shows it."""
        staff_id = seeded_reception["staff_ra"]
        resp = client.patch(f"{STAFF}/{staff_id}", json={"active": False})
        assert resp.status_code == 200
        assert resp.json()["active"] is False

        default_list = client.get(STAFF).json()
        assert staff_id not in {s["id"] for s in default_list}

        full_list = client.get(
            STAFF, params={"include_inactive": True}
        ).json()
        matched = next(s for s in full_list if s["id"] == staff_id)
        assert matched["active"] is False

    def test_default_list_excludes_seeded_inactive(self, client, seeded_reception):
        default_list = client.get(STAFF).json()
        assert seeded_reception["staff_rd_inactive"] not in {
            s["id"] for s in default_list
        }
        full_list = client.get(STAFF, params={"include_inactive": True}).json()
        assert seeded_reception["staff_rd_inactive"] in {s["id"] for s in full_list}

    def test_patch_reactivates(self, client, seeded_reception):
        staff_id = seeded_reception["staff_rd_inactive"]
        resp = client.patch(f"{STAFF}/{staff_id}", json={"active": True})
        assert resp.status_code == 200
        assert resp.json()["active"] is True

    def test_get_or_404(self, client, seeded_reception):
        resp = client.patch(f"{STAFF}/999999", json={"code": "X"})
        assert resp.status_code == 404


class TestStaffUsage:
    def test_counts_on_a_seeded_member(self, client, db_session, seeded_reception):
        staff_id = seeded_reception["staff_ra"]
        _seed_history(db_session, [staff_id])

        body = client.get(f"{STAFF}/{staff_id}/usage").json()
        assert body == {
            "master_sessions": 2,
            "rota_sessions": 2,
            "generated_days": 2,
            "leave_entries": 2,
        }

    def test_zeroes_on_a_fresh_member(self, client, seeded_reception):
        staff_id = seeded_reception["staff_rb"]
        body = client.get(f"{STAFF}/{staff_id}/usage").json()
        assert body == {
            "master_sessions": 0,
            "rota_sessions": 0,
            "generated_days": 0,
            "leave_entries": 0,
        }

    def test_404_on_unknown_id(self, client, seeded_reception):
        assert client.get(f"{STAFF}/999999/usage").status_code == 404

    def test_readable_by_a_viewer(self, viewer_client, db_session):
        """Usage is a GET, so reception:read is enough even though the
        delete it describes needs `user_admin` on top of reception:write."""
        staff = ReceptionStaff(code="RZ", active=True)
        db_session.add(staff)
        db_session.commit()
        assert viewer_client.get(f"{STAFF}/{staff.id}/usage").status_code == 200


class TestPermanentDelete:
    def test_purges_every_child_table(self, client, db_session, seeded_reception):
        staff_id = seeded_reception["staff_ra"]
        _seed_history(db_session, [staff_id])
        _deactivate(client, staff_id)

        resp = client.delete(f"{STAFF}/{staff_id}")
        assert resp.status_code == 200, resp.text
        assert resp.json() == {"deleted": {
            "master_sessions": 2, "rota_sessions": 2, "leave_entries": 2,
        }}

        db_session.expire_all()
        assert db_session.get(ReceptionStaff, staff_id) is None
        for model in PURGED_MODELS:
            assert _rows_for(db_session, model, staff_id) == []

        full_list = client.get(STAFF, params={"include_inactive": True}).json()
        assert staff_id not in {s["id"] for s in full_list}

    def test_leave_entries_are_purged(self, client, db_session, seeded_reception):
        """Called out separately from the sweep above: leave is the easiest
        of the three child tables to forget."""
        staff_id = seeded_reception["staff_ra"]
        db_session.add(ReceptionLeaveEntry(staff_id=staff_id, date=DAY_ONE))
        db_session.commit()
        _deactivate(client, staff_id)

        resp = client.delete(f"{STAFF}/{staff_id}")
        assert resp.status_code == 200
        assert resp.json()["deleted"]["leave_entries"] == 1
        db_session.expire_all()
        assert _rows_for(db_session, ReceptionLeaveEntry, staff_id) == []

    def test_other_staff_are_untouched(self, client, db_session, seeded_reception):
        doomed = seeded_reception["staff_ra"]
        keeper = seeded_reception["staff_rb"]
        _seed_history(db_session, [doomed, keeper])
        _deactivate(client, doomed)

        assert client.delete(f"{STAFF}/{doomed}").status_code == 200

        db_session.expire_all()
        assert db_session.get(ReceptionStaff, keeper) is not None
        for model in PURGED_MODELS:
            assert len(_rows_for(db_session, model, keeper)) == 2

    def test_emptied_rota_header_survives(self, client, db_session, seeded_reception):
        """An empty header means "generated, then emptied", which is not the
        same as "never generated" -- the purge must not collapse the two."""
        staff_id = seeded_reception["staff_ra"]
        _seed_history(db_session, [staff_id], dates=(DAY_ONE,))
        _deactivate(client, staff_id)

        assert client.delete(f"{STAFF}/{staff_id}").status_code == 200

        db_session.expire_all()
        headers = db_session.query(ReceptionRota).filter(
            ReceptionRota.date == DAY_ONE
        ).all()
        assert len(headers) == 1

        resp = client.get("/api/v1/reception/rota", params={"date": DAY_ONE.isoformat()})
        assert resp.status_code == 200
        assert resp.json()["sessions"] == []

    def test_409_while_active(self, client, db_session, seeded_reception):
        staff_id = seeded_reception["staff_ra"]
        _seed_history(db_session, [staff_id])

        resp = client.delete(f"{STAFF}/{staff_id}")
        assert resp.status_code == 409
        assert "RA" in resp.json()["detail"]

        db_session.expire_all()
        assert db_session.get(ReceptionStaff, staff_id) is not None
        for model in PURGED_MODELS:
            assert _rows_for(db_session, model, staff_id) != []

    def test_404_on_unknown_id(self, client, seeded_reception):
        assert client.delete(f"{STAFF}/999999").status_code == 404

    def test_linked_user_is_nulled_not_deleted(
        self, client, db_session, seeded_reception
    ):
        """users references reception_staff but is nulled, not purged: the
        login survives the staff member it pointed at, and the null-out is
        not reported among the destroyed-history counts."""
        staff_id = seeded_reception["staff_ra"]
        linked = User(
            email="linked@example.com",
            name="Linked",
            password_hash="x",
            reception_staff_id=staff_id,
        )
        db_session.add(linked)
        db_session.commit()
        _deactivate(client, staff_id)

        resp = client.delete(f"{STAFF}/{staff_id}")
        assert resp.status_code == 200, resp.text
        assert "users" not in resp.json()["deleted"]

        db_session.expire_all()
        survivor = db_session.get(User, linked.id)
        assert survivor is not None
        assert survivor.reception_staff_id is None


class TestPermanentDeleteNeedsUserAdmin:
    """One client fixture per test -- they share app.dependency_overrides,
    so a second would silently change the first's identity."""

    @staticmethod
    def _inactive_staff(db):
        staff = ReceptionStaff(code="RZ", active=False)
        db.add(staff)
        db.commit()
        return staff.id

    def test_manager_can_delete(self, manager_client, db_session):
        staff_id = self._inactive_staff(db_session)
        assert manager_client.delete(f"{STAFF}/{staff_id}").status_code == 200

    def test_a_rota_admin_cannot_delete(self, admin_client, db_session):
        """A reception editor passes the router's area gate but not the
        endpoint's `user_admin` one: an irreversible, history-destroying
        action is the narrower permission."""
        staff_id = self._inactive_staff(db_session)
        assert admin_client.delete(f"{STAFF}/{staff_id}").status_code == 403
        db_session.expire_all()
        assert db_session.get(ReceptionStaff, staff_id) is not None

    def test_viewer_cannot_delete(self, viewer_client, db_session):
        staff_id = self._inactive_staff(db_session)
        assert viewer_client.delete(f"{STAFF}/{staff_id}").status_code == 403


def test_purged_models_covers_every_fk_to_reception_staff():
    """The delete is explicit rather than ON DELETE CASCADE, so a new table
    with a staff FK would silently go unpurged. This is the tripwire."""
    referencing = set()
    for table in Base.metadata.tables.values():
        for column in table.columns:
            for fk in column.foreign_keys:
                if fk.column.table.name == "reception_staff":
                    referencing.add(table.name)

    assert referencing == {m.__tablename__ for m in PURGED_MODELS} | set(
        NULLED_TABLES
    ), (
        "a table references reception_staff but is neither purged nor nulled "
        "when a staff member is deleted -- add its model to PURGED_MODELS "
        "(or its table to NULLED_TABLES) in "
        "app/api/routers/reception_staff.py"
    )
