"""Leave and duty router tests (M3 Task 8; bulk add/remove added post-M4)."""


class TestLeave:
    def test_create_list_delete(self, client, seeded):
        resp = client.post("/api/v1/leave", json={
            "doctor_id": seeded["doctor_aa"], "date": "2026-01-05", "period": "AM",
        })
        assert resp.status_code == 201
        leave_id = resp.json()["id"]

        listed = client.get(
            f"/api/v1/leave?doctor_id={seeded['doctor_aa']}"
            "&from_date=2026-01-01&to_date=2026-01-31"
        ).json()
        assert len(listed) == 1

        assert client.delete(f"/api/v1/leave/{leave_id}").status_code == 204
        assert client.get("/api/v1/leave").json() == []

    def test_duplicate_409(self, client, seeded):
        payload = {
            "doctor_id": seeded["doctor_aa"], "date": "2026-01-05", "period": "AM",
        }
        assert client.post("/api/v1/leave", json=payload).status_code == 201
        assert client.post("/api/v1/leave", json=payload).status_code == 409


class TestLeaveBulkCreate:
    def test_weekday_expansion_both_period(self, client, seeded):
        # 2026-01-05 is a Monday; range covers Mon-Fri plus the following weekend.
        resp = client.post("/api/v1/leave/bulk", json={
            "doctor_id": seeded["doctor_aa"],
            "start_date": "2026-01-05", "end_date": "2026-01-11",
            "period": "BOTH",
        })
        assert resp.status_code == 200, resp.text
        body = resp.json()
        assert len(body["created"]) == 10  # 5 weekdays x AM/PM
        weekend_skips = [s for s in body["skipped"] if s["reason"] == "weekend"]
        assert len(weekend_skips) == 4  # Sat + Sun x AM/PM
        assert all(s["reason"] == "weekend" for s in weekend_skips)

    def test_partial_duplicate_skip(self, client, seeded):
        # Pre-create one entry inside the range.
        client.post("/api/v1/leave", json={
            "doctor_id": seeded["doctor_aa"], "date": "2026-01-06", "period": "AM",
        })
        resp = client.post("/api/v1/leave/bulk", json={
            "doctor_id": seeded["doctor_aa"],
            "start_date": "2026-01-05", "end_date": "2026-01-06",
            "period": "AM",
        })
        assert resp.status_code == 200
        body = resp.json()
        assert len(body["created"]) == 1
        dup_skips = [s for s in body["skipped"] if s["reason"] == "duplicate"]
        assert len(dup_skips) == 1
        assert dup_skips[0]["date"] == "2026-01-06"

    def test_doctor_404(self, client, seeded):
        resp = client.post("/api/v1/leave/bulk", json={
            "doctor_id": 999999,
            "start_date": "2026-01-05", "end_date": "2026-01-06",
            "period": "AM",
        })
        assert resp.status_code == 404

    def test_bad_range_422(self, client, seeded):
        resp = client.post("/api/v1/leave/bulk", json={
            "doctor_id": seeded["doctor_aa"],
            "start_date": "2026-01-10", "end_date": "2026-01-05",
            "period": "AM",
        })
        assert resp.status_code == 422

    def test_range_too_long_422(self, client, seeded):
        resp = client.post("/api/v1/leave/bulk", json={
            "doctor_id": seeded["doctor_aa"],
            "start_date": "2026-01-01", "end_date": "2027-01-10",
            "period": "AM",
        })
        assert resp.status_code == 422


class TestLeaveBulkDelete:
    def test_deletes_range_including_weekend_entry(self, client, seeded):
        # One weekday entry and one manually-added weekend entry, both in range.
        client.post("/api/v1/leave", json={
            "doctor_id": seeded["doctor_aa"], "date": "2026-01-05", "period": "AM",
        })
        client.post("/api/v1/leave", json={
            "doctor_id": seeded["doctor_aa"], "date": "2026-01-10", "period": "AM",
        })  # 2026-01-10 is a Saturday

        resp = client.post("/api/v1/leave/bulk-delete", json={
            "doctor_id": seeded["doctor_aa"],
            "start_date": "2026-01-01", "end_date": "2026-01-11",
            "period": "AM",
        })
        assert resp.status_code == 200
        assert resp.json()["deleted_count"] == 2
        assert client.get("/api/v1/leave").json() == []

    def test_doctor_404(self, client, seeded):
        resp = client.post("/api/v1/leave/bulk-delete", json={
            "doctor_id": 999999,
            "start_date": "2026-01-05", "end_date": "2026-01-06",
            "period": "AM",
        })
        assert resp.status_code == 404

    def test_no_matches_returns_zero(self, client, seeded):
        resp = client.post("/api/v1/leave/bulk-delete", json={
            "doctor_id": seeded["doctor_aa"],
            "start_date": "2026-01-05", "end_date": "2026-01-06",
            "period": "AM",
        })
        assert resp.status_code == 200
        assert resp.json()["deleted_count"] == 0


class TestDuty:
    def test_create_list_delete(self, client, seeded):
        resp = client.post("/api/v1/duty", json={
            "date": "2026-01-05", "period": "AM",
            "doctor_id": seeded["doctor_aa"], "duty_type": "primary",
        })
        assert resp.status_code == 201
        duty_id = resp.json()["id"]

        listed = client.get(
            "/api/v1/duty?from_date=2026-01-01&to_date=2026-01-31"
        ).json()
        assert len(listed) == 1

        assert client.delete(f"/api/v1/duty/{duty_id}").status_code == 204

    def test_duplicate_slot_409(self, client, seeded):
        payload = {
            "date": "2026-01-05", "period": "AM",
            "doctor_id": seeded["doctor_aa"], "duty_type": "primary",
        }
        assert client.post("/api/v1/duty", json=payload).status_code == 201
        payload["doctor_id"] = seeded["doctor_bb"]  # same slot, different doctor
        assert client.post("/api/v1/duty", json=payload).status_code == 409