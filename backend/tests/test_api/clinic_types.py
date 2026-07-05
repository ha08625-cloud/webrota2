"""ClinicType router tests (M3 Task 8)."""
from .conftest import make_clinic_type_via_api


class TestClinicTypes:
    def test_create_with_nested_children(self, client, seeded):
        created = make_clinic_type_via_api(client, seeded)
        assert created["name"] == "Dragon"
        assert len(created["schedules"]) == 1
        assert len(created["doctor_eligibilities"]) == 1
        assert len(created["room_eligibilities"]) == 1

    def test_get_returns_children(self, client, seeded):
        created = make_clinic_type_via_api(client, seeded)
        got = client.get(f"/api/v1/clinic-types/{created['id']}").json()
        assert got["schedules"][0]["day"] == "Monday"
        assert got["room_eligibilities"][0]["room_id"] == seeded["room_c1"]

    def test_put_replaces_children(self, client, seeded):
        created = make_clinic_type_via_api(client, seeded)
        resp = client.put(f"/api/v1/clinic-types/{created['id']}", json={
            "name": "Dragon",
            "clinic_priority": 20,
            "room_required": False,
            "schedules": [
                {"day": "Tuesday", "period": "PM"},
                {"day": "Friday", "period": "AM"},
            ],
            "doctor_eligibilities": [],
            "room_eligibilities": [{"room_type": "D"}],
        })
        assert resp.status_code == 200, resp.text
        body = resp.json()
        assert body["clinic_priority"] == 20
        assert {s["day"] for s in body["schedules"]} == {"Tuesday", "Friday"}
        assert body["doctor_eligibilities"] == []
        assert body["room_eligibilities"][0]["room_type"] == "D"

    def test_duplicate_name_409(self, client, seeded):
        make_clinic_type_via_api(client, seeded)
        resp = client.post("/api/v1/clinic-types", json={
            "name": "Dragon", "clinic_priority": 5,
        })
        assert resp.status_code == 409

    def test_room_elig_xor_422(self, client, seeded):
        resp = client.post("/api/v1/clinic-types", json={
            "name": "Bad", "clinic_priority": 5,
            "room_eligibilities": [{"room_id": seeded["room_c1"], "room_type": "C"}],
        })
        assert resp.status_code == 422

    def test_delete_cascades(self, client, seeded):
        created = make_clinic_type_via_api(client, seeded)
        assert client.delete(f"/api/v1/clinic-types/{created['id']}").status_code == 204
        assert client.get(f"/api/v1/clinic-types/{created['id']}").status_code == 404
        assert client.get("/api/v1/clinic-types").json() == []