import datetime

from app.models import Doctor
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

class TestDutyCounts:
    def test_empty_counts(self, client, seeded, db_session):
        """Active doctors should be returned with a count of 0, ordered by code."""
        resp = client.get("/api/v1/duty/counts")
        assert resp.status_code == 200
        
        data = resp.json()
        assert len(data) > 0  # Assuming seeded data creates some active doctors
        
        # Verify zeros and ordering
        codes = []
        for d in data:
            assert d["raw_count"] == 0
            codes.append(d["doctor_code"])
        
        assert codes == sorted(codes)

    def test_multiple_assignments_and_combined_types(self, client, seeded, db_session):
        """Should sum both PRIMARY and SECONDARY duties, ignoring dates."""
        d1 = DutyAssignment(date=datetime.date(2026, 2, 1), period=Period.AM, doctor_id=seeded["doctor_aa"], duty_type=DutyType.PRIMARY)
        d2 = DutyAssignment(date=datetime.date(2026, 2, 2), period=Period.PM, doctor_id=seeded["doctor_aa"], duty_type=DutyType.PRIMARY)
        d3 = DutyAssignment(date=datetime.date(2026, 2, 3), period=Period.AM, doctor_id=seeded["doctor_aa"], duty_type=DutyType.SECONDARY)
        
        db_session.add_all([d1, d2, d3])
        db_session.commit()

        resp = client.get("/api/v1/duty/counts")
        assert resp.status_code == 200
        data = resp.json()
        
        aa_count = next(d for d in data if d["doctor_id"] == seeded["doctor_aa"])
        assert aa_count["raw_count"] == 3

    def test_inactive_doctor_excluded(self, client, seeded, db_session):
        """Inactive doctors must not appear in the payload at all."""
        doc = db_session.get(Doctor, seeded["doctor_bb"])
        doc.active = False
        db_session.commit()

        resp = client.get("/api/v1/duty/counts")
        data = resp.json()
        
        assert not any(d["doctor_id"] == seeded["doctor_bb"] for d in data)

    def test_date_filtering_join_vs_where(self, client, seeded, db_session):
        """
        Regression test: Date filters must apply to the JOIN condition, 
        not the WHERE clause. A doctor with duties outside the window 
        should still appear in the list with a count of 0.
        """
        # Out-of-window duty
        d1 = DutyAssignment(date=datetime.date(2026, 1, 1), period=Period.AM, doctor_id=seeded["doctor_aa"], duty_type=DutyType.PRIMARY)
        # In-window duty
        d2 = DutyAssignment(date=datetime.date(2026, 2, 1), period=Period.AM, doctor_id=seeded["doctor_bb"], duty_type=DutyType.PRIMARY)
        
        db_session.add_all([d1, d2])
        db_session.commit()

        # Query just the February window
        resp = client.get("/api/v1/duty/counts?from_date=2026-02-01&to_date=2026-02-28")
        data = resp.json()

        aa_count = next(d for d in data if d["doctor_id"] == seeded["doctor_aa"])
        bb_count = next(d for d in data if d["doctor_id"] == seeded["doctor_bb"])

        # Doctor AA is still fetched due to outer join, but their Jan assignment is omitted from the count
        assert aa_count["raw_count"] == 0
        assert bb_count["raw_count"] == 1