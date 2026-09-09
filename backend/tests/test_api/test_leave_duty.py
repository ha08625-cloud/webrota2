import datetime

from app.models import Doctor
from app.models import DutyAssignment
from app.models.enums import DutyType, Period

# ... (existing TestLeave and TestLeaveBulk classes)

MONDAY = datetime.date(2026, 1, 5)
WEDNESDAY = datetime.date(2026, 1, 7)
SUNDAY = datetime.date(2026, 1, 11)


class TestLeaveDoctorWindow:
    """Employment window enforcement on the leave entry endpoints: the
    single-entry POST 422s, the bulk POST reports a skip and still inserts
    the rest."""

    def _set_window(self, client, doctor_id, **dates):
        resp = client.patch(f"/api/v1/doctors/{doctor_id}", json={
            k: v.isoformat() for k, v in dates.items()
        })
        assert resp.status_code == 200, resp.text

    def test_create_before_start_date_422(self, client, seeded):
        self._set_window(client, seeded["doctor_aa"], start_date=WEDNESDAY)
        resp = client.post("/api/v1/leave", json={
            "doctor_id": seeded["doctor_aa"],
            "date": MONDAY.isoformat(),
            "period": "AM",
        })
        assert resp.status_code == 422
        detail = resp.json()["detail"]
        assert "AA" in detail and "does not work" in detail

    def test_create_after_end_date_422(self, client, seeded):
        self._set_window(client, seeded["doctor_aa"], end_date=MONDAY)
        resp = client.post("/api/v1/leave", json={
            "doctor_id": seeded["doctor_aa"],
            "date": WEDNESDAY.isoformat(),
            "period": "AM",
        })
        assert resp.status_code == 422
        assert "does not work" in resp.json()["detail"]

    def test_create_inside_window_201(self, client, seeded):
        self._set_window(
            client, seeded["doctor_aa"], start_date=MONDAY, end_date=SUNDAY
        )
        resp = client.post("/api/v1/leave", json={
            "doctor_id": seeded["doctor_aa"],
            "date": WEDNESDAY.isoformat(),
            "period": "AM",
        })
        assert resp.status_code == 201, resp.text

    def test_create_unbounded_window_unaffected(self, client, seeded):
        """Both nulls -- every existing row -- must behave exactly as
        before the window existed."""
        resp = client.post("/api/v1/leave", json={
            "doctor_id": seeded["doctor_aa"],
            "date": MONDAY.isoformat(),
            "period": "AM",
        })
        assert resp.status_code == 201, resp.text

    def test_bulk_skips_out_of_window_and_inserts_the_rest(self, client, seeded):
        """A range straddling the start date: the in-window portion is
        inserted, the out-of-window portion is reported rather than
        failing the call."""
        self._set_window(client, seeded["doctor_aa"], start_date=WEDNESDAY)
        resp = client.post("/api/v1/leave/bulk", json={
            "doctor_id": seeded["doctor_aa"],
            "start_date": MONDAY.isoformat(),
            "end_date": SUNDAY.isoformat(),
            "period": "BOTH",
        })
        assert resp.status_code == 200, resp.text
        body = resp.json()

        created_dates = {c["date"] for c in body["created"]}
        assert created_dates == {"2026-01-07", "2026-01-08", "2026-01-09"}
        assert len(body["created"]) == 6  # AM + PM for each

        by_reason: dict[str, set[str]] = {}
        for s in body["skipped"]:
            by_reason.setdefault(s["reason"], set()).add(s["date"])
        assert by_reason["outside_doctor_dates"] == {"2026-01-05", "2026-01-06"}
        assert by_reason["weekend"] == {"2026-01-10", "2026-01-11"}

    def test_bulk_weekend_reason_wins_over_window(self, client, seeded):
        """A weekend date that is also out of window reports "weekend" --
        the existing check runs first and is the more specific fact."""
        self._set_window(client, seeded["doctor_aa"], end_date=MONDAY)
        resp = client.post("/api/v1/leave/bulk", json={
            "doctor_id": seeded["doctor_aa"],
            "start_date": SUNDAY.isoformat(),
            "end_date": SUNDAY.isoformat(),
            "period": "AM",
        })
        assert resp.status_code == 200, resp.text
        assert [s["reason"] for s in resp.json()["skipped"]] == ["weekend"]

    def test_bulk_entirely_out_of_window_creates_nothing(self, client, seeded):
        self._set_window(client, seeded["doctor_aa"], start_date=SUNDAY)
        body = client.post("/api/v1/leave/bulk", json={
            "doctor_id": seeded["doctor_aa"],
            "start_date": MONDAY.isoformat(),
            "end_date": WEDNESDAY.isoformat(),
            "period": "AM",
        }).json()
        assert body["created"] == []
        assert {s["reason"] for s in body["skipped"]} == {"outside_doctor_dates"}
        assert client.get("/api/v1/leave").json() == []


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
        """M5: when Monday is fully closed (both periods), secondary duty
        moves to Tuesday -- the closures plan's fully-open rule."""
        from app.models import PracticeClosure
        db_session.add(PracticeClosure(date=datetime.date(2026, 1, 5), period=Period.AM))
        db_session.add(PracticeClosure(date=datetime.date(2026, 1, 5), period=Period.PM))
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
        """Once Monday AM is closed, secondary duty on Monday AM itself hits
        the closed-slot check (not the day-mismatch message - that check
        runs first)."""
        from app.models import PracticeClosure
        db_session.add(PracticeClosure(date=datetime.date(2026, 1, 5), period=Period.AM))
        db_session.commit()

        resp = client.post("/api/v1/duty", json={
            "date": "2026-01-05",
            "period": "AM",
            "doctor_id": seeded["doctor_aa"],
            "duty_type": "secondary",
        })
        assert resp.status_code == 422
        assert "is closed" in resp.json()["detail"]

    def test_create_duty_on_closed_date_422(self, client, db_session, seeded):
        """M5 plan review note 4: any duty (not just secondary) on its own
        closed period is rejected at the API, mirroring Phase 0's
        duty_on_closed_date hard error."""
        from app.models import PracticeClosure
        db_session.add(PracticeClosure(date=datetime.date(2026, 1, 5), period=Period.AM))
        db_session.commit()

        resp = client.post("/api/v1/duty", json={
            "date": "2026-01-05",
            "period": "AM",
            "doctor_id": seeded["doctor_aa"],
            "duty_type": "primary",
        })
        assert resp.status_code == 422
        assert "is closed" in resp.json()["detail"]

    def test_create_primary_duty_on_open_half_of_partly_closed_day_201(
        self, client, db_session, seeded
    ):
        """A primary duty on the open half of a half-closed day is accepted
        -- only the assignment's own (date, period) is checked, not the
        whole date."""
        from app.models import PracticeClosure
        db_session.add(PracticeClosure(date=datetime.date(2026, 1, 5), period=Period.PM))
        db_session.commit()

        resp = client.post("/api/v1/duty", json={
            "date": "2026-01-05",
            "period": "AM",
            "doctor_id": seeded["doctor_aa"],
            "duty_type": "primary",
        })
        assert resp.status_code == 201, resp.text

    def test_create_primary_duty_on_closed_half_of_partly_closed_day_422(
        self, client, db_session, seeded
    ):
        """The other half of the same day, however, is rejected."""
        from app.models import PracticeClosure
        db_session.add(PracticeClosure(date=datetime.date(2026, 1, 5), period=Period.PM))
        db_session.commit()

        resp = client.post("/api/v1/duty", json={
            "date": "2026-01-05",
            "period": "PM",
            "doctor_id": seeded["doctor_aa"],
            "duty_type": "primary",
        })
        assert resp.status_code == 422
        assert "is closed" in resp.json()["detail"]

    def test_secondary_duty_requires_fully_open_weekday_not_just_open_slot(
        self, client, db_session, seeded
    ):
        """Monday is half-closed (PM only) -- Monday AM is itself an open
        slot, but Monday is not a *fully* open weekday, so secondary duty
        must move to Tuesday (the first day with neither period closed),
        not stay on Monday."""
        from app.models import PracticeClosure
        db_session.add(PracticeClosure(date=datetime.date(2026, 1, 5), period=Period.PM))
        db_session.commit()

        rejected = client.post("/api/v1/duty", json={
            "date": "2026-01-05",  # Monday AM: open, but not a fully open weekday
            "period": "AM",
            "doctor_id": seeded["doctor_aa"],
            "duty_type": "secondary",
        })
        assert rejected.status_code == 422
        assert "must be assigned on 2026-01-06" in rejected.json()["detail"]

        accepted = client.post("/api/v1/duty", json={
            "date": "2026-01-06",  # Tuesday: the first fully open weekday
            "period": "AM",
            "doctor_id": seeded["doctor_aa"],
            "duty_type": "secondary",
        })
        assert accepted.status_code == 201, accepted.text

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


class TestDutyDoctorWindow:
    """Employment window enforcement on POST /duty: a DB-backed 422
    in the router, mirroring
    Phase 0's duty_outside_doctor_dates hard error."""

    def _set_window(self, client, doctor_id, **dates):
        resp = client.patch(f"/api/v1/doctors/{doctor_id}", json={
            k: v.isoformat() for k, v in dates.items()
        })
        assert resp.status_code == 200, resp.text

    def _post_duty(self, client, doctor_id, date_, duty_type="primary"):
        return client.post("/api/v1/duty", json={
            "date": date_.isoformat(),
            "period": "AM",
            "doctor_id": doctor_id,
            "duty_type": duty_type,
        })

    def test_create_before_start_date_422(self, client, seeded):
        self._set_window(client, seeded["doctor_aa"], start_date=WEDNESDAY)

        resp = self._post_duty(client, seeded["doctor_aa"], MONDAY)

        assert resp.status_code == 422
        detail = resp.json()["detail"]
        assert "AA" in detail and "does not work" in detail
        assert "duty cannot be assigned there" in detail

    def test_create_after_end_date_422(self, client, seeded):
        self._set_window(client, seeded["doctor_aa"], end_date=MONDAY)

        resp = self._post_duty(client, seeded["doctor_aa"], WEDNESDAY)

        assert resp.status_code == 422
        assert "does not work" in resp.json()["detail"]

    def test_create_inside_window_201(self, client, seeded):
        self._set_window(
            client, seeded["doctor_aa"], start_date=MONDAY, end_date=WEDNESDAY,
        )

        resp = self._post_duty(client, seeded["doctor_aa"], WEDNESDAY)

        assert resp.status_code == 201, resp.text

    def test_create_unbounded_window_unaffected(self, client, seeded):
        resp = self._post_duty(client, seeded["doctor_aa"], WEDNESDAY)

        assert resp.status_code == 201, resp.text


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