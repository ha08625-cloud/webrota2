import datetime

from app.models import DutyAssignment
from app.models.enums import DutyType, Period

# ... (existing TestLeave and TestLeaveBulk classes)

class TestDuty:
    # ... (existing test_create_list_delete and test_duplicate_slot_409)

    def test_legacy_off_monday_secondary_lists_cleanly(self, client, seeded, db_session):
        """A legacy secondary duty on a non-Monday bypasses Pydantic on creation
        but must not crash the GET endpoint during response model validation."""
        legacy_duty = DutyAssignment(
            date=datetime.date(2026, 1, 6),  # Tuesday
            period=Period.AM,
            doctor_id=seeded["doctor_aa"],
            duty_type=DutyType.SECONDARY,
        )
        db_session.add(legacy_duty)
        db_session.commit()

        resp = client.get("/api/v1/duty?from_date=2026-01-06&to_date=2026-01-06")
        assert resp.status_code == 200
        
        data = resp.json()
        assert len(data) == 1
        assert data[0]["duty_type"] == "secondary"
        assert data[0]["date"] == "2026-01-06"

    def test_create_secondary_duty_non_monday_422(self, client, seeded):
        """Secondary duty on a day other than the week's first open
        weekday is rejected. With no closures in effect that's always
        Monday - same behaviour as before M5 - but the check has moved
        from a stateless pydantic validator to the router (it now needs
        PracticeClosure data), so detail is a plain string, not a FastAPI
        validation-error list.
        """
        resp = client.post("/api/v1/duty", json={
            "date": "2026-01-06",  # Tuesday
            "period": "AM",
            "doctor_id": seeded["doctor_aa"],
            "duty_type": "secondary",
        })
        assert resp.status_code == 422
        assert "must be assigned on 2026-01-05" in resp.json()["detail"]

    def test_create_secondary_duty_monday_201(self, client, seeded):
        """Secondary duty assignment on a Monday succeeds."""
        resp = client.post("/api/v1/duty", json={
            "date": "2026-01-05",  # Monday
            "period": "AM",
            "doctor_id": seeded["doctor_aa"],
            "duty_type": "secondary",
        })
        assert resp.status_code == 201
        assert resp.json()["duty_type"] == "secondary"

    def test_create_secondary_duty_moves_with_closure_201(self, client, db_session, seeded):
        """M5: when Monday is closed, secondary duty moves to Tuesday."""
        from app.models import PracticeClosure
        db_session.add(PracticeClosure(date=datetime.date(2026, 1, 5)))
        db_session.commit()

        resp = client.post("/api/v1/duty", json={
            "date": "2026-01-06",  # the week's new first open day
            "period": "AM",
            "doctor_id": seeded["doctor_aa"],
            "duty_type": "secondary",
        })
        assert resp.status_code == 201, resp.text
        assert resp.json()["duty_type"] == "secondary"

    def test_create_secondary_duty_monday_422_when_monday_closed(self, client, db_session, seeded):
        """Once Monday is closed, secondary duty on Monday itself hits the
        closed-date check (not the day-mismatch message - that check runs
        first)."""
        from app.models import PracticeClosure
        db_session.add(PracticeClosure(date=datetime.date(2026, 1, 5)))
        db_session.commit()

        resp = client.post("/api/v1/duty", json={
            "date": "2026-01-05",
            "period": "AM",
            "doctor_id": seeded["doctor_aa"],
            "duty_type": "secondary",
        })
        assert resp.status_code == 422
        assert "closed date" in resp.json()["detail"]

    def test_create_duty_on_closed_date_422(self, client, db_session, seeded):
        """M5 plan review note 4: any duty (not just secondary) on a
        closed date is rejected at the API, mirroring Phase 0's
        duty_on_closed_date hard error."""
        from app.models import PracticeClosure
        db_session.add(PracticeClosure(date=datetime.date(2026, 1, 5)))
        db_session.commit()

        resp = client.post("/api/v1/duty", json={
            "date": "2026-01-05",
            "period": "AM",
            "doctor_id": seeded["doctor_aa"],
            "duty_type": "primary",
        })
        assert resp.status_code == 422
        assert "closed date" in resp.json()["detail"]

    def test_create_secondary_duty_monday_201(self, client, seeded):
        """Secondary duty assignment on a Monday succeeds."""
        resp = client.post("/api/v1/duty", json={
            "date": "2026-01-05",  # Monday
            "period": "AM",
            "doctor_id": seeded["doctor_aa"],
            "duty_type": "secondary",
        })
        assert resp.status_code == 201
        assert resp.json()["duty_type"] == "secondary"