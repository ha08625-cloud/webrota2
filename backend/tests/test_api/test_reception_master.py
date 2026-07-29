"""Reception weekday master template router tests."""


class TestReceptionMaster:
    def test_create_and_list_ordering(self, client, seeded_reception):
        ra, rb, rc = (
            seeded_reception["staff_ra"],
            seeded_reception["staff_rb"],
            seeded_reception["staff_rc"],
        )
        # Deliberately out of order: Tuesday before Monday, hour 10 before 9,
        # RC before RA within the same (day, hour) -- GET must reorder all
        # three axes (day, hour, staff_code).
        for staff_id, day, hour in (
            (rc, "Tuesday", 10),
            (ra, "Monday", 10),
            (rc, "Monday", 9),
            (ra, "Monday", 9),
            (rb, "Monday", 9),
        ):
            resp = client.post("/api/v1/reception/master/sessions", json={
                "staff_id": staff_id, "day": day, "hour": hour,
            })
            assert resp.status_code == 201, resp.text

        listed = client.get("/api/v1/reception/master").json()
        assert [(s["day"], s["hour"], s["staff_code"]) for s in listed] == [
            ("Monday", 9, "RA"),
            ("Monday", 9, "RB"),
            ("Monday", 9, "RC"),
            ("Monday", 10, "RA"),
            ("Tuesday", 10, "RC"),
        ]
        # Default role/note.
        assert listed[0]["role"] == "phones"
        assert listed[0]["note"] is None

    def test_create_with_role_and_note(self, client, seeded_reception):
        resp = client.post("/api/v1/reception/master/sessions", json={
            "staff_id": seeded_reception["staff_ra"],
            "day": "Wednesday", "hour": 14,
            "role": "other", "note": "training",
        })
        assert resp.status_code == 201
        body = resp.json()
        assert body["role"] == "other"
        assert body["note"] == "training"
        assert body["staff_code"] == "RA"
        assert body["staff_name"] == "Alice Reception"

    def test_duplicate_slot_409(self, client, seeded_reception):
        payload = {
            "staff_id": seeded_reception["staff_ra"], "day": "Monday", "hour": 9,
        }
        first = client.post("/api/v1/reception/master/sessions", json=payload)
        assert first.status_code == 201
        second = client.post("/api/v1/reception/master/sessions", json=payload)
        assert second.status_code == 409

    def test_unknown_staff_404(self, client, seeded_reception):
        resp = client.post("/api/v1/reception/master/sessions", json={
            "staff_id": 999999, "day": "Monday", "hour": 9,
        })
        assert resp.status_code == 404

    def test_several_staff_share_one_slot(self, client, seeded_reception):
        for staff_id in (
            seeded_reception["staff_ra"],
            seeded_reception["staff_rb"],
            seeded_reception["staff_rc"],
        ):
            resp = client.post("/api/v1/reception/master/sessions", json={
                "staff_id": staff_id, "day": "Monday", "hour": 9,
            })
            assert resp.status_code == 201, resp.text

        listed = client.get("/api/v1/reception/master").json()
        assert {s["staff_code"] for s in listed} == {"RA", "RB", "RC"}

    def test_patch_pair_setter(self, client, seeded_reception):
        created = client.post("/api/v1/reception/master/sessions", json={
            "staff_id": seeded_reception["staff_ra"], "day": "Monday", "hour": 9,
        }).json()

        resp = client.patch(
            f"/api/v1/reception/master/sessions/{created['session_id']}",
            json={"role": "other", "note": "post"},
        )
        assert resp.status_code == 200
        body = resp.json()
        assert body["role"] == "other"
        assert body["note"] == "post"

        # Setting note back to null clears it -- both fields required, so
        # this exercises the "note is None" branch of the pair setter.
        resp2 = client.patch(
            f"/api/v1/reception/master/sessions/{created['session_id']}",
            json={"role": "phones", "note": None},
        )
        assert resp2.status_code == 200
        assert resp2.json() == {**body, "role": "phones", "note": None}

    def test_patch_missing_session_404(self, client, seeded_reception):
        resp = client.patch(
            "/api/v1/reception/master/sessions/999999",
            json={"role": "phones", "note": None},
        )
        assert resp.status_code == 404

    def test_patch_requires_both_fields(self, client, seeded_reception):
        created = client.post("/api/v1/reception/master/sessions", json={
            "staff_id": seeded_reception["staff_ra"], "day": "Monday", "hour": 9,
        }).json()
        resp = client.patch(
            f"/api/v1/reception/master/sessions/{created['session_id']}",
            json={"role": "other"},
        )
        assert resp.status_code == 422

    def test_delete_session(self, client, seeded_reception):
        created = client.post("/api/v1/reception/master/sessions", json={
            "staff_id": seeded_reception["staff_ra"], "day": "Monday", "hour": 9,
        }).json()
        resp = client.delete(
            f"/api/v1/reception/master/sessions/{created['session_id']}"
        )
        assert resp.status_code == 204

        listed = client.get("/api/v1/reception/master").json()
        assert listed == []

    def test_delete_missing_session_404(self, client, seeded_reception):
        resp = client.delete("/api/v1/reception/master/sessions/999999")
        assert resp.status_code == 404

    def test_hour_out_of_range_422(self, client, seeded_reception):
        resp = client.post("/api/v1/reception/master/sessions", json={
            "staff_id": seeded_reception["staff_ra"], "day": "Monday", "hour": 7,
        })
        assert resp.status_code == 422
