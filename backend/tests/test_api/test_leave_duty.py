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
        """Secondary duty assignment on any day other than Monday is rejected."""
        resp = client.post("/api/v1/duty", json={
            "date": "2026-01-06",  # Tuesday
            "period": "AM",
            "doctor_id": seeded["doctor_aa"],
            "duty_type": "secondary",
        })
        assert resp.status_code == 422
        
        # Verify the specific validator triggered, not just a random 422
        errors = resp.json()["detail"]
        assert any("Secondary duty can only be assigned on a Monday" in err["msg"] for err in errors)

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