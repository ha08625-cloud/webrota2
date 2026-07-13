"""Closures router tests (M5 Task 2).

Uses the shared `client`/`seeded` fixtures from conftest.py; closures don't
depend on any of `seeded`'s reference data, but the fixture is harmless to
include and keeps this file consistent with the other router test files.
"""


class TestClosures:
    def test_create_and_list(self, client, seeded):
        resp = client.post("/api/v1/closures", json={
            "date": "2026-01-05", "name": "Bank Holiday",
        })
        assert resp.status_code == 201
        body = resp.json()
        assert body["date"] == "2026-01-05"
        assert body["name"] == "Bank Holiday"
        assert "id" in body

        listed = client.get("/api/v1/closures").json()
        assert len(listed) == 1
        assert listed[0]["date"] == "2026-01-05"

    def test_name_is_optional(self, client, seeded):
        resp = client.post("/api/v1/closures", json={"date": "2026-01-05"})
        assert resp.status_code == 201
        assert resp.json()["name"] is None

    def test_weekend_date_422(self, client, seeded):
        resp = client.post("/api/v1/closures", json={"date": "2026-01-10"})  # Saturday
        assert resp.status_code == 422
        errors = resp.json()["detail"]
        assert any("weekday" in err["msg"] for err in errors)

    def test_duplicate_date_409(self, client, seeded):
        client.post("/api/v1/closures", json={"date": "2026-01-05"})
        resp = client.post("/api/v1/closures", json={"date": "2026-01-05"})
        assert resp.status_code == 409

    def test_delete(self, client, seeded):
        created = client.post("/api/v1/closures", json={"date": "2026-01-05"}).json()
        resp = client.delete(f"/api/v1/closures/{created['id']}")
        assert resp.status_code == 204
        assert client.get("/api/v1/closures").json() == []

    def test_delete_unknown_404(self, client, seeded):
        resp = client.delete("/api/v1/closures/999999")
        assert resp.status_code == 404

    def test_list_filtered_by_date_range(self, client, seeded):
        client.post("/api/v1/closures", json={"date": "2026-01-05"})
        client.post("/api/v1/closures", json={"date": "2026-06-01"})

        resp = client.get(
            "/api/v1/closures?from_date=2026-01-01&to_date=2026-01-31"
        )
        assert resp.status_code == 200
        dates = [c["date"] for c in resp.json()]
        assert dates == ["2026-01-05"]

    def test_list_ordered_by_date(self, client, seeded):
        client.post("/api/v1/closures", json={"date": "2026-06-01"})
        client.post("/api/v1/closures", json={"date": "2026-01-05"})

        dates = [c["date"] for c in client.get("/api/v1/closures").json()]
        assert dates == ["2026-01-05", "2026-06-01"]

    def test_delete_does_not_affect_a_generated_rota(
        self, client, db_session, seeded
    ):
        """M5 Decision 4: deleting a PracticeClosure must not change how an
        already-generated rota renders or validates -- it reads its own
        RotaClosure snapshot instead. End-to-end coverage of the snapshot
        mechanism lives in test_rota.py; this only confirms the delete
        endpoint itself succeeds regardless of prior generation use."""
        from .conftest import MONDAY, generate_rota

        created = client.post(
            "/api/v1/closures", json={"date": MONDAY.isoformat()}
        ).json()
        out = generate_rota(client)

        resp = client.delete(f"/api/v1/closures/{created['id']}")
        assert resp.status_code == 204

        rota = client.get(f"/api/v1/rota/{out['rota_id']}").json()
        assert rota["closed_dates"] == [MONDAY.isoformat()]