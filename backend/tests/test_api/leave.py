"""Leave and duty router tests (M3 Task 8)."""


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