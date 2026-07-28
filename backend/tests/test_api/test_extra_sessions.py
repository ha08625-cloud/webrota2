"""Extra sessions router tests (extra sessions plan, Task 1)."""
import datetime

from app.models import ExtraSessionEntry, LeaveEntry
from app.models.enums import Period

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