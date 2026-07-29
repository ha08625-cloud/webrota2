"""Reception staff router tests (reception rota, Task 2)."""


class TestReceptionStaff:
    def test_create_and_list(self, client, seeded_reception):
        resp = client.post("/api/v1/reception/staff", json={
            "code": "RE", "name": "Eve Reception",
        })
        assert resp.status_code == 201
        body = resp.json()
        assert body["code"] == "RE"
        assert body["name"] == "Eve Reception"
        assert body["active"] is True

        listed = client.get("/api/v1/reception/staff").json()
        assert {s["code"] for s in listed} == {"RA", "RB", "RC", "RE"}

    def test_duplicate_code_409(self, client, seeded_reception):
        resp = client.post("/api/v1/reception/staff", json={
            "code": "RA", "name": "Duplicate",
        })
        assert resp.status_code == 409

    def test_patch_name(self, client, seeded_reception):
        url = f"/api/v1/reception/staff/{seeded_reception['staff_ra']}"
        resp = client.patch(url, json={"name": "Alice Updated"})
        assert resp.status_code == 200
        body = resp.json()
        assert body["name"] == "Alice Updated"
        assert body["code"] == "RA"  # untouched

    def test_patch_duplicate_code_409(self, client, seeded_reception):
        url = f"/api/v1/reception/staff/{seeded_reception['staff_ra']}"
        resp = client.patch(url, json={"code": "RB"})
        assert resp.status_code == 409

    def test_soft_delete_then_list(self, client, seeded_reception):
        staff_id = seeded_reception["staff_ra"]
        resp = client.delete(f"/api/v1/reception/staff/{staff_id}")
        assert resp.status_code == 204

        default_list = client.get("/api/v1/reception/staff").json()
        assert staff_id not in {s["id"] for s in default_list}

        full_list = client.get(
            "/api/v1/reception/staff", params={"include_inactive": True}
        ).json()
        matched = next(s for s in full_list if s["id"] == staff_id)
        assert matched["active"] is False

    def test_default_list_excludes_seeded_inactive(self, client, seeded_reception):
        default_list = client.get("/api/v1/reception/staff").json()
        assert seeded_reception["staff_rd_inactive"] not in {
            s["id"] for s in default_list
        }
        full_list = client.get(
            "/api/v1/reception/staff", params={"include_inactive": True}
        ).json()
        assert seeded_reception["staff_rd_inactive"] in {s["id"] for s in full_list}

    def test_patch_reactivates(self, client, seeded_reception):
        staff_id = seeded_reception["staff_rd_inactive"]
        resp = client.patch(
            f"/api/v1/reception/staff/{staff_id}", json={"active": True}
        )
        assert resp.status_code == 200
        assert resp.json()["active"] is True

    def test_get_or_404(self, client, seeded_reception):
        resp = client.patch("/api/v1/reception/staff/999999", json={"name": "X"})
        assert resp.status_code == 404
