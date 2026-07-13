"""Doctor router tests (M3 Task 8)."""
from .conftest import generate_rota


class TestDoctors:
    def test_create_and_get(self, client, seeded):
        resp = client.post("/api/v1/doctors", json={
            "code": "CC", "doctor_type": "Trainee",
        })
        assert resp.status_code == 201
        body = resp.json()
        assert body["sessions_per_week"] == "10.0"
        got = client.get(f"/api/v1/doctors/{body['id']}").json()
        assert got["code"] == "CC"
        assert got["preferred_rooms"] == []

    def test_duplicate_code_409(self, client, seeded):
        resp = client.post("/api/v1/doctors", json={
            "code": "AA", "doctor_type": "Partner",
        })
        assert resp.status_code == 409

    def test_patch_partial_update(self, client, seeded):
        resp = client.patch(f"/api/v1/doctors/{seeded['doctor_aa']}", json={
            "sessions_per_week": "6.0",
        })
        assert resp.status_code == 200
        body = resp.json()
        assert body["sessions_per_week"] == "6.0"
        assert body["code"] == "AA"  # untouched

    def test_active_only_filter(self, client, seeded):
        client.delete(f"/api/v1/doctors/{seeded['doctor_bb']}")
        codes = {d["code"] for d in client.get("/api/v1/doctors").json()}
        assert codes == {"AA"}
        codes_all = {
            d["code"]
            for d in client.get("/api/v1/doctors?active_only=false").json()
        }
        assert codes_all == {"AA", "BB"}

    def test_preferred_rooms_replace(self, client, seeded):
        url = f"/api/v1/doctors/{seeded['doctor_aa']}/preferred-rooms"
        resp = client.put(url, json=[
            {"preference_order": 1, "room_id": seeded["room_d1"]},
            {"preference_order": 2, "room_type": "C"},
        ])
        assert resp.status_code == 200
        assert len(resp.json()["preferred_rooms"]) == 2
        resp = client.put(url, json=[{"preference_order": 1, "room_type": "W"}])
        assert len(resp.json()["preferred_rooms"]) == 1

    def test_soft_delete_blocked_by_committed_rota(self, client, seeded):
        out = generate_rota(client)
        client.post(f"/api/v1/rota/{out['rota_id']}/commit")
        resp = client.delete(f"/api/v1/doctors/{seeded['doctor_aa']}")
        assert resp.status_code == 409
        # Doctor with only draft history: scrap first, then delete succeeds.