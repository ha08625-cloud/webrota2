"""Schools and school holidays router tests.

Uses the shared `client`/`seeded` fixtures from conftest.py; schools don't
depend on any of `seeded`'s reference data, but the fixture is harmless to
include and keeps this file consistent with the other router test files.
"""


class TestSchools:
    def test_create_and_list(self, client, seeded):
        resp = client.post("/api/v1/schools", json={"name": "Riverside Primary"})
        assert resp.status_code == 201
        body = resp.json()
        assert body["name"] == "Riverside Primary"
        assert body["holidays"] == []
        assert "id" in body

        listed = client.get("/api/v1/schools").json()
        assert len(listed) == 1
        assert listed[0]["name"] == "Riverside Primary"

    def test_duplicate_name_409(self, client, seeded):
        client.post("/api/v1/schools", json={"name": "Riverside Primary"})
        resp = client.post("/api/v1/schools", json={"name": "Riverside Primary"})
        assert resp.status_code == 409

    def test_list_ordered_by_name(self, client, seeded):
        client.post("/api/v1/schools", json={"name": "Zetland School"})
        client.post("/api/v1/schools", json={"name": "Ashfield School"})

        listed = client.get("/api/v1/schools").json()
        assert [s["name"] for s in listed] == ["Ashfield School", "Zetland School"]

    def test_rename(self, client, seeded):
        created = client.post("/api/v1/schools", json={"name": "Old Name"}).json()
        resp = client.patch(f"/api/v1/schools/{created['id']}", json={"name": "New Name"})
        assert resp.status_code == 200
        assert resp.json()["name"] == "New Name"

    def test_rename_unknown_404(self, client, seeded):
        resp = client.patch("/api/v1/schools/999999", json={"name": "New Name"})
        assert resp.status_code == 404

    def test_rename_duplicate_409(self, client, seeded):
        client.post("/api/v1/schools", json={"name": "School A"})
        b = client.post("/api/v1/schools", json={"name": "School B"}).json()
        resp = client.patch(f"/api/v1/schools/{b['id']}", json={"name": "School A"})
        assert resp.status_code == 409

    def test_delete(self, client, seeded):
        created = client.post("/api/v1/schools", json={"name": "Riverside Primary"}).json()
        resp = client.delete(f"/api/v1/schools/{created['id']}")
        assert resp.status_code == 204
        assert client.get("/api/v1/schools").json() == []

    def test_delete_unknown_404(self, client, seeded):
        resp = client.delete("/api/v1/schools/999999")
        assert resp.status_code == 404

    def test_delete_cascades_holidays(self, client, seeded):
        school = client.post("/api/v1/schools", json={"name": "Riverside Primary"}).json()
        client.post(
            f"/api/v1/schools/{school['id']}/holidays",
            json={"start_date": "2026-07-21", "end_date": "2026-08-31"},
        )
        resp = client.delete(f"/api/v1/schools/{school['id']}")
        assert resp.status_code == 204
        assert client.get("/api/v1/schools").json() == []


class TestSchoolHolidays:
    def _school(self, client) -> dict:
        return client.post("/api/v1/schools", json={"name": "Riverside Primary"}).json()

    def test_create_and_nested_in_list(self, client, seeded):
        school = self._school(client)
        resp = client.post(
            f"/api/v1/schools/{school['id']}/holidays",
            json={"start_date": "2026-07-21", "end_date": "2026-08-31", "name": "Summer"},
        )
        assert resp.status_code == 201
        body = resp.json()
        assert body["start_date"] == "2026-07-21"
        assert body["end_date"] == "2026-08-31"
        assert body["name"] == "Summer"
        assert body["school_id"] == school["id"]

        listed = client.get("/api/v1/schools").json()
        assert len(listed[0]["holidays"]) == 1
        assert listed[0]["holidays"][0]["name"] == "Summer"

    def test_name_is_optional(self, client, seeded):
        school = self._school(client)
        resp = client.post(
            f"/api/v1/schools/{school['id']}/holidays",
            json={"start_date": "2026-07-21", "end_date": "2026-08-31"},
        )
        assert resp.status_code == 201
        assert resp.json()["name"] is None

    def test_holidays_listed_ordered_by_start_date(self, client, seeded):
        school = self._school(client)
        client.post(
            f"/api/v1/schools/{school['id']}/holidays",
            json={"start_date": "2026-12-12", "end_date": "2027-01-04"},
        )
        client.post(
            f"/api/v1/schools/{school['id']}/holidays",
            json={"start_date": "2026-07-21", "end_date": "2026-08-31"},
        )

        listed = client.get("/api/v1/schools").json()
        starts = [h["start_date"] for h in listed[0]["holidays"]]
        assert starts == ["2026-07-21", "2026-12-12"]

    def test_end_before_start_422(self, client, seeded):
        school = self._school(client)
        resp = client.post(
            f"/api/v1/schools/{school['id']}/holidays",
            json={"start_date": "2026-08-31", "end_date": "2026-07-21"},
        )
        assert resp.status_code == 422

    def test_span_over_366_days_422(self, client, seeded):
        school = self._school(client)
        resp = client.post(
            f"/api/v1/schools/{school['id']}/holidays",
            json={"start_date": "2026-01-01", "end_date": "2027-01-05"},
        )
        assert resp.status_code == 422

    def test_span_of_366_days_allowed(self, client, seeded):
        school = self._school(client)
        resp = client.post(
            f"/api/v1/schools/{school['id']}/holidays",
            json={"start_date": "2026-01-01", "end_date": "2027-01-02"},
        )
        assert resp.status_code == 201

    def test_weekend_spanning_range_allowed(self, client, seeded):
        """Regression guard: unlike ClosureIn, SchoolHolidayIn must not
        reject weekend-adjacent or weekend-spanning dates."""
        school = self._school(client)
        resp = client.post(
            f"/api/v1/schools/{school['id']}/holidays",
            json={"start_date": "2026-07-18", "end_date": "2026-07-19"},  # Sat-Sun
        )
        assert resp.status_code == 201

    def test_create_holiday_under_missing_school_404(self, client, seeded):
        resp = client.post(
            "/api/v1/schools/999999/holidays",
            json={"start_date": "2026-07-21", "end_date": "2026-08-31"},
        )
        assert resp.status_code == 404

    def test_update_holiday(self, client, seeded):
        school = self._school(client)
        holiday = client.post(
            f"/api/v1/schools/{school['id']}/holidays",
            json={"start_date": "2026-07-21", "end_date": "2026-08-31", "name": "Summer"},
        ).json()

        resp = client.patch(
            f"/api/v1/schools/{school['id']}/holidays/{holiday['id']}",
            json={"start_date": "2026-07-22", "end_date": "2026-09-01", "name": "Summer holidays"},
        )
        assert resp.status_code == 200
        body = resp.json()
        assert body["start_date"] == "2026-07-22"
        assert body["end_date"] == "2026-09-01"
        assert body["name"] == "Summer holidays"

    def test_update_holiday_missing_school_404(self, client, seeded):
        school = self._school(client)
        holiday = client.post(
            f"/api/v1/schools/{school['id']}/holidays",
            json={"start_date": "2026-07-21", "end_date": "2026-08-31"},
        ).json()

        resp = client.patch(
            f"/api/v1/schools/999999/holidays/{holiday['id']}",
            json={"start_date": "2026-07-21", "end_date": "2026-08-31"},
        )
        assert resp.status_code == 404

    def test_update_holiday_from_another_school_404(self, client, seeded):
        school_a = self._school(client)
        school_b = client.post("/api/v1/schools", json={"name": "Other School"}).json()
        holiday = client.post(
            f"/api/v1/schools/{school_a['id']}/holidays",
            json={"start_date": "2026-07-21", "end_date": "2026-08-31"},
        ).json()

        resp = client.patch(
            f"/api/v1/schools/{school_b['id']}/holidays/{holiday['id']}",
            json={"start_date": "2026-07-21", "end_date": "2026-08-31"},
        )
        assert resp.status_code == 404

    def test_delete_holiday(self, client, seeded):
        school = self._school(client)
        holiday = client.post(
            f"/api/v1/schools/{school['id']}/holidays",
            json={"start_date": "2026-07-21", "end_date": "2026-08-31"},
        ).json()

        resp = client.delete(f"/api/v1/schools/{school['id']}/holidays/{holiday['id']}")
        assert resp.status_code == 204
        assert client.get("/api/v1/schools").json()[0]["holidays"] == []

    def test_delete_holiday_missing_school_404(self, client, seeded):
        school = self._school(client)
        holiday = client.post(
            f"/api/v1/schools/{school['id']}/holidays",
            json={"start_date": "2026-07-21", "end_date": "2026-08-31"},
        ).json()

        resp = client.delete(f"/api/v1/schools/999999/holidays/{holiday['id']}")
        assert resp.status_code == 404

    def test_delete_holiday_from_another_school_404(self, client, seeded):
        school_a = self._school(client)
        school_b = client.post("/api/v1/schools", json={"name": "Other School"}).json()
        holiday = client.post(
            f"/api/v1/schools/{school_a['id']}/holidays",
            json={"start_date": "2026-07-21", "end_date": "2026-08-31"},
        ).json()

        resp = client.delete(f"/api/v1/schools/{school_b['id']}/holidays/{holiday['id']}")
        assert resp.status_code == 404


class TestSchoolsAuth:
    def test_unauthenticated_401(self, client_no_auth):
        assert client_no_auth.get("/api/v1/schools").status_code == 401
        assert client_no_auth.post("/api/v1/schools", json={"name": "X"}).status_code == 401
