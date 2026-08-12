"""Closures router tests (M5 Task 2, extended for half-day closures).

Uses the shared `client`/`seeded` fixtures from conftest.py; closures don't
depend on any of `seeded`'s reference data, but the fixture is harmless to
include and keeps this file consistent with the other router test files.
"""


class TestClosures:
    def test_create_and_list(self, client, seeded):
        resp = client.post("/api/v1/closures", json={
            "date": "2026-01-05", "period": "AM", "name": "Bank Holiday",
        })
        assert resp.status_code == 201
        body = resp.json()
        assert body["date"] == "2026-01-05"
        assert body["period"] == "AM"
        assert body["name"] == "Bank Holiday"
        assert "id" in body

        listed = client.get("/api/v1/closures").json()
        assert len(listed) == 1
        assert listed[0]["date"] == "2026-01-05"
        assert listed[0]["period"] == "AM"

    def test_name_is_optional(self, client, seeded):
        resp = client.post("/api/v1/closures", json={"date": "2026-01-05", "period": "AM"})
        assert resp.status_code == 201
        assert resp.json()["name"] is None

    def test_weekend_date_422(self, client, seeded):
        resp = client.post(
            "/api/v1/closures", json={"date": "2026-01-10", "period": "AM"}
        )  # Saturday
        assert resp.status_code == 422
        errors = resp.json()["detail"]
        assert any("weekday" in err["msg"] for err in errors)

    def test_duplicate_date_and_period_409(self, client, seeded):
        client.post("/api/v1/closures", json={"date": "2026-01-05", "period": "AM"})
        resp = client.post("/api/v1/closures", json={"date": "2026-01-05", "period": "AM"})
        assert resp.status_code == 409

    def test_other_period_same_date_allowed(self, client, seeded):
        """A closure on one period of a date does not block the other --
        this is the half-day closure the M5-half-day plan exists for."""
        first = client.post("/api/v1/closures", json={"date": "2026-01-05", "period": "AM"})
        assert first.status_code == 201
        second = client.post("/api/v1/closures", json={"date": "2026-01-05", "period": "PM"})
        assert second.status_code == 201

        listed = client.get("/api/v1/closures").json()
        assert len(listed) == 2

    def test_full_day_closure_is_two_rows(self, client, seeded):
        """No 'FULL' period sentinel exists -- a full-day
        closure is two POSTs, one per period, for the same date."""
        am = client.post("/api/v1/closures", json={"date": "2026-01-05", "period": "AM"})
        pm = client.post("/api/v1/closures", json={"date": "2026-01-05", "period": "PM"})
        assert am.status_code == 201
        assert pm.status_code == 201
        assert am.json()["id"] != pm.json()["id"]

    def test_delete(self, client, seeded):
        created = client.post(
            "/api/v1/closures", json={"date": "2026-01-05", "period": "AM"}
        ).json()
        resp = client.delete(f"/api/v1/closures/{created['id']}")
        assert resp.status_code == 204
        assert client.get("/api/v1/closures").json() == []

    def test_delete_unknown_404(self, client, seeded):
        resp = client.delete("/api/v1/closures/999999")
        assert resp.status_code == 404

    def test_list_filtered_by_date_range(self, client, seeded):
        client.post("/api/v1/closures", json={"date": "2026-01-05", "period": "AM"})
        client.post("/api/v1/closures", json={"date": "2026-06-01", "period": "AM"})

        resp = client.get(
            "/api/v1/closures?from_date=2026-01-01&to_date=2026-01-31"
        )
        assert resp.status_code == 200
        dates = [c["date"] for c in resp.json()]
        assert dates == ["2026-01-05"]

    def test_list_ordered_by_date_then_period(self, client, seeded):
        client.post("/api/v1/closures", json={"date": "2026-06-01", "period": "AM"})
        client.post("/api/v1/closures", json={"date": "2026-01-05", "period": "PM"})
        client.post("/api/v1/closures", json={"date": "2026-01-05", "period": "AM"})

        listed = client.get("/api/v1/closures").json()
        slots = [(c["date"], c["period"]) for c in listed]
        assert slots == [
            ("2026-01-05", "AM"),
            ("2026-01-05", "PM"),
            ("2026-06-01", "AM"),
        ]

    def test_list_bank_holidays_defaults_to_no_dates(self, client, seeded):
        resp = client.get("/api/v1/closures/bank-holidays?year=2026")
        assert resp.status_code == 200
        body = resp.json()
        assert len(body) == 8
        assert all(h["date"] is None for h in body)
        assert {h["key"] for h in body} == {
            "new_year", "good_friday", "easter_monday", "early_may",
            "spring", "summer", "christmas_day", "boxing_day",
        }

    def test_set_bank_holiday_creates_full_day_closure(self, client, seeded):
        resp = client.put(
            "/api/v1/closures/bank-holidays/christmas_day?year=2026",
            json={"date": "2026-12-25"},
        )
        assert resp.status_code == 200
        assert resp.json() == {
            "key": "christmas_day", "name": "Christmas Day bank holiday", "date": "2026-12-25",
        }

        listed = client.get("/api/v1/closures").json()
        assert len(listed) == 2
        assert {c["period"] for c in listed} == {"AM", "PM"}
        assert all(c["date"] == "2026-12-25" for c in listed)
        assert all(c["name"] == "Christmas Day bank holiday" for c in listed)

        holidays = client.get("/api/v1/closures/bank-holidays?year=2026").json()
        christmas = next(h for h in holidays if h["key"] == "christmas_day")
        assert christmas["date"] == "2026-12-25"

    def test_set_bank_holiday_replaces_previous_date(self, client, seeded):
        client.put(
            "/api/v1/closures/bank-holidays/christmas_day?year=2026",
            json={"date": "2026-12-25"},
        )
        resp = client.put(
            "/api/v1/closures/bank-holidays/christmas_day?year=2026",
            json={"date": "2026-12-28"},
        )
        assert resp.status_code == 200
        listed = client.get("/api/v1/closures").json()
        assert len(listed) == 2
        assert all(c["date"] == "2026-12-28" for c in listed)

    def test_clear_bank_holiday_deletes_closure(self, client, seeded):
        client.put(
            "/api/v1/closures/bank-holidays/christmas_day?year=2026",
            json={"date": "2026-12-25"},
        )
        resp = client.put(
            "/api/v1/closures/bank-holidays/christmas_day?year=2026",
            json={"date": None},
        )
        assert resp.status_code == 200
        assert resp.json()["date"] is None
        assert client.get("/api/v1/closures").json() == []

    def test_set_bank_holiday_weekend_422(self, client, seeded):
        resp = client.put(
            "/api/v1/closures/bank-holidays/new_year?year=2026",
            json={"date": "2026-01-10"},  # Saturday
        )
        assert resp.status_code == 422

    def test_set_bank_holiday_unknown_key_404(self, client, seeded):
        resp = client.put(
            "/api/v1/closures/bank-holidays/not_a_real_holiday?year=2026",
            json={"date": "2026-01-05"},
        )
        assert resp.status_code == 404

    def test_bank_holidays_scoped_by_year(self, client, seeded):
        client.put(
            "/api/v1/closures/bank-holidays/christmas_day?year=2026",
            json={"date": "2026-12-25"},
        )
        holidays_2027 = client.get("/api/v1/closures/bank-holidays?year=2027").json()
        christmas_2027 = next(h for h in holidays_2027 if h["key"] == "christmas_day")
        assert christmas_2027["date"] is None

    def test_delete_does_not_affect_a_generated_rota(
        self, client, db_session, seeded
    ):
        """deleting a PracticeClosure must not change how an
        already-generated rota renders or validates -- it reads its own
        RotaClosure snapshot instead. End-to-end coverage of the snapshot
        mechanism lives in test_rota.py; this only confirms the delete
        endpoint itself succeeds regardless of prior generation use."""
        from .conftest import MONDAY, generate_rota

        created = client.post(
            "/api/v1/closures", json={"date": MONDAY.isoformat(), "period": "AM"}
        ).json()
        out = generate_rota(client)

        resp = client.delete(f"/api/v1/closures/{created['id']}")
        assert resp.status_code == 204

        rota = client.get(f"/api/v1/rota/{out['rota_id']}").json()
        assert rota["closed_slots"] == [{"date": MONDAY.isoformat(), "period": "AM"}]
