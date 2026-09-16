"""Extra sessions router tests (extra sessions plan, Task 1)."""
import datetime

import pytest

from app.models import Doctor, ExtraSessionEntry, LeaveEntry
from app.models.enums import (
    DoctorType,
    ExtraSessionCompensation,
    Period,
    SystemCounterType,
)
from app.models.counter import SystemCounter

MONDAY = datetime.date(2026, 1, 5)
SATURDAY = datetime.date(2026, 1, 10)


class TestExtraSessions:
    def test_create_and_list_round_trip(self, client, seeded):
        resp = client.post("/api/v1/extra-sessions", json={
            "doctor_id": seeded["doctor_aa"],
            "date": MONDAY.isoformat(),
            "period": "AM",
        })
        assert resp.status_code == 201, resp.text
        body = resp.json()
        assert body["doctor_id"] == seeded["doctor_aa"]
        assert body["date"] == MONDAY.isoformat()
        assert body["period"] == "AM"
        assert "id" in body

        listed = client.get("/api/v1/extra-sessions").json()
        assert len(listed) == 1
        assert listed[0]["id"] == body["id"]

    def test_create_unknown_doctor_404(self, client, seeded):
        resp = client.post("/api/v1/extra-sessions", json={
            "doctor_id": 999999,
            "date": MONDAY.isoformat(),
            "period": "AM",
        })
        assert resp.status_code == 404

    def test_create_weekend_date_422(self, client, seeded):
        resp = client.post("/api/v1/extra-sessions", json={
            "doctor_id": seeded["doctor_aa"],
            "date": SATURDAY.isoformat(),
            "period": "AM",
        })
        assert resp.status_code == 422
        assert "weekend" in resp.json()["detail"]

    def test_create_duplicate_409(self, client, seeded):
        payload = {
            "doctor_id": seeded["doctor_aa"],
            "date": MONDAY.isoformat(),
            "period": "AM",
        }
        first = client.post("/api/v1/extra-sessions", json=payload)
        assert first.status_code == 201
        second = client.post("/api/v1/extra-sessions", json=payload)
        assert second.status_code == 409

    def test_create_blocked_by_existing_leave_409(self, client, db_session, seeded):
        db_session.add(LeaveEntry(
            doctor_id=seeded["doctor_aa"], date=MONDAY, period=Period.AM,
        ))
        db_session.commit()

        resp = client.post("/api/v1/extra-sessions", json={
            "doctor_id": seeded["doctor_aa"],
            "date": MONDAY.isoformat(),
            "period": "AM",
        })
        assert resp.status_code == 409
        assert "on leave" in resp.json()["detail"]

    def test_create_before_doctor_start_date_422(self, client, seeded):
        client.patch(f"/api/v1/doctors/{seeded['doctor_aa']}", json={
            "start_date": (MONDAY + datetime.timedelta(days=7)).isoformat(),
        })
        resp = client.post("/api/v1/extra-sessions", json={
            "doctor_id": seeded["doctor_aa"],
            "date": MONDAY.isoformat(),
            "period": "AM",
        })
        assert resp.status_code == 422
        assert "does not work" in resp.json()["detail"]

    def test_create_after_doctor_end_date_422(self, client, seeded):
        client.patch(f"/api/v1/doctors/{seeded['doctor_aa']}", json={
            "end_date": (MONDAY - datetime.timedelta(days=1)).isoformat(),
        })
        resp = client.post("/api/v1/extra-sessions", json={
            "doctor_id": seeded["doctor_aa"],
            "date": MONDAY.isoformat(),
            "period": "AM",
        })
        assert resp.status_code == 422
        assert "does not work" in resp.json()["detail"]

    def test_create_inside_window_201(self, client, seeded):
        client.patch(f"/api/v1/doctors/{seeded['doctor_aa']}", json={
            "start_date": MONDAY.isoformat(),
            "end_date": (MONDAY + datetime.timedelta(days=30)).isoformat(),
        })
        resp = client.post("/api/v1/extra-sessions", json={
            "doctor_id": seeded["doctor_aa"],
            "date": MONDAY.isoformat(),
            "period": "AM",
        })
        assert resp.status_code == 201, resp.text

    def test_weekend_check_precedes_window_check(self, client, seeded):
        """A Saturday that is also outside the window reports the weekend,
        the more specific fact -- same ordering as /leave/bulk."""
        client.patch(f"/api/v1/doctors/{seeded['doctor_aa']}", json={
            "start_date": (SATURDAY + datetime.timedelta(days=7)).isoformat(),
        })
        resp = client.post("/api/v1/extra-sessions", json={
            "doctor_id": seeded["doctor_aa"],
            "date": SATURDAY.isoformat(),
            "period": "AM",
        })
        assert resp.status_code == 422
        assert "weekend" in resp.json()["detail"]

    def test_delete_then_404(self, client, seeded):
        created = client.post("/api/v1/extra-sessions", json={
            "doctor_id": seeded["doctor_aa"],
            "date": MONDAY.isoformat(),
            "period": "PM",
        }).json()

        resp = client.delete(f"/api/v1/extra-sessions/{created['id']}")
        assert resp.status_code == 204

        resp = client.delete(f"/api/v1/extra-sessions/{created['id']}")
        assert resp.status_code == 404

    def test_list_filters(self, client, seeded):
        client.post("/api/v1/extra-sessions", json={
            "doctor_id": seeded["doctor_aa"],
            "date": MONDAY.isoformat(),
            "period": "AM",
        })
        client.post("/api/v1/extra-sessions", json={
            "doctor_id": seeded["doctor_bb"],
            "date": (MONDAY + datetime.timedelta(days=1)).isoformat(),
            "period": "PM",
        })

        by_doctor = client.get(
            f"/api/v1/extra-sessions?doctor_id={seeded['doctor_aa']}"
        ).json()
        assert len(by_doctor) == 1
        assert by_doctor[0]["doctor_id"] == seeded["doctor_aa"]

        by_range = client.get(
            "/api/v1/extra-sessions"
            f"?from_date={MONDAY.isoformat()}&to_date={MONDAY.isoformat()}"
        ).json()
        assert len(by_range) == 1
        assert by_range[0]["date"] == MONDAY.isoformat()

@pytest.fixture
def locum(db_session):
    """A Locum, which `LEAVE_WEEKS_BY_DOCTOR_TYPE` omits -- the `seeded`
    fixture has only a Partner and a Salaried, both entitled."""
    doctor = Doctor(
        code="LL", doctor_type=DoctorType.LOCUM, sessions_per_week=10, active=True
    )
    db_session.add(doctor)
    db_session.flush()
    for ct in SystemCounterType:
        db_session.add(SystemCounter(doctor_id=doctor.id, counter_type=ct, raw_count=0))
    db_session.commit()
    return doctor.id


class TestCompensation:
    """TOIL or Payment on an extra session (TOIL plan, Task 2)."""

    def test_defaults_to_payment_when_omitted(self, client, seeded):
        """An existing client that has never heard of the field keeps
        working and keeps meaning what it meant."""
        resp = client.post("/api/v1/extra-sessions", json={
            "doctor_id": seeded["doctor_aa"],
            "date": MONDAY.isoformat(),
            "period": "AM",
        })
        assert resp.status_code == 201, resp.text
        assert resp.json()["compensation"] == "Payment"
        assert client.get("/api/v1/extra-sessions").json()[0][
            "compensation"
        ] == "Payment"

    def test_create_toil_for_entitled_doctor(self, client, db_session, seeded):
        resp = client.post("/api/v1/extra-sessions", json={
            "doctor_id": seeded["doctor_aa"],
            "date": MONDAY.isoformat(),
            "period": "AM",
            "compensation": "TOIL",
        })
        assert resp.status_code == 201, resp.text
        assert resp.json()["compensation"] == "TOIL"
        row = db_session.query(ExtraSessionEntry).one()
        assert row.compensation is ExtraSessionCompensation.TOIL

    def test_create_toil_for_locum_422(self, client, db_session, locum):
        resp = client.post("/api/v1/extra-sessions", json={
            "doctor_id": locum,
            "date": MONDAY.isoformat(),
            "period": "AM",
            "compensation": "TOIL",
        })
        assert resp.status_code == 422
        assert "no leave entitlement" in resp.json()["detail"]
        assert db_session.query(ExtraSessionEntry).count() == 0

    def test_create_payment_for_locum_201(self, client, locum):
        """Only TOIL is refused; a locum is paid for an extra session, which
        is the whole reason the type has no entitlement."""
        resp = client.post("/api/v1/extra-sessions", json={
            "doctor_id": locum,
            "date": MONDAY.isoformat(),
            "period": "AM",
            "compensation": "Payment",
        })
        assert resp.status_code == 201, resp.text

    def test_patch_round_trip(self, client, db_session, seeded):
        created = client.post("/api/v1/extra-sessions", json={
            "doctor_id": seeded["doctor_aa"],
            "date": MONDAY.isoformat(),
            "period": "AM",
        }).json()
        assert created["compensation"] == "Payment"

        resp = client.patch(
            f"/api/v1/extra-sessions/{created['id']}",
            json={"compensation": "TOIL"},
        )
        assert resp.status_code == 200, resp.text
        assert resp.json()["compensation"] == "TOIL"
        assert resp.json()["id"] == created["id"]

        resp = client.patch(
            f"/api/v1/extra-sessions/{created['id']}",
            json={"compensation": "Payment"},
        )
        assert resp.status_code == 200, resp.text
        assert resp.json()["compensation"] == "Payment"
        db_session.expire_all()
        assert db_session.query(ExtraSessionEntry).one().compensation is (
            ExtraSessionCompensation.PAYMENT
        )

    def test_patch_unknown_id_404(self, client, seeded):
        resp = client.patch(
            "/api/v1/extra-sessions/999999", json={"compensation": "TOIL"}
        )
        assert resp.status_code == 404

    def test_patch_toil_on_locum_row_422(self, client, db_session, locum):
        created = client.post("/api/v1/extra-sessions", json={
            "doctor_id": locum,
            "date": MONDAY.isoformat(),
            "period": "AM",
        }).json()

        resp = client.patch(
            f"/api/v1/extra-sessions/{created['id']}",
            json={"compensation": "TOIL"},
        )
        assert resp.status_code == 422
        assert "no leave entitlement" in resp.json()["detail"]
        db_session.expire_all()
        assert db_session.query(ExtraSessionEntry).one().compensation is (
            ExtraSessionCompensation.PAYMENT
        )

    def test_patch_requires_compensation(self, client, seeded):
        """A PATCH body that changes nothing is a client bug here, unlike
        LeaveEntitlementIn's all-optional shape."""
        created = client.post("/api/v1/extra-sessions", json={
            "doctor_id": seeded["doctor_aa"],
            "date": MONDAY.isoformat(),
            "period": "AM",
        }).json()
        resp = client.patch(f"/api/v1/extra-sessions/{created['id']}", json={})
        assert resp.status_code == 422
