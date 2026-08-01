"""Reception coverage-rules router tests (reception rota, Task 2)."""
from app.models.reception import RECEPTION_HOURS


class TestReceptionCoverage:
    def test_list_ordered_by_weekday_then_hour(self, client, seeded_reception):
        rules = client.get("/api/v1/reception/coverage-rules").json()
        assert len(rules) == 20  # one per half-hour, 8.0..17.5, Monday only in the fixture
        assert all(r["day"] == "Monday" for r in rules)
        assert [r["hour"] for r in rules] == list(RECEPTION_HOURS)

    def test_seeded_minimums(self, client, seeded_reception):
        rules = {r["hour"]: r["min_phones_staff"] for r in
                  client.get("/api/v1/reception/coverage-rules").json()}
        assert rules[9] == 3
        assert rules[9.5] == 3
        assert rules[10] == 3
        assert rules[10.5] == 3
        assert rules[8] == 2
        assert rules[8.5] == 2
        assert rules[17.5] == 2

    def test_patch_round_trip(self, client, seeded_reception):
        rules = client.get("/api/v1/reception/coverage-rules").json()
        rule = next(r for r in rules if r["hour"] == 12)

        resp = client.patch(
            f"/api/v1/reception/coverage-rules/{rule['id']}",
            json={"min_phones_staff": 5},
        )
        assert resp.status_code == 200
        assert resp.json()["min_phones_staff"] == 5

        refetched = client.get("/api/v1/reception/coverage-rules").json()
        updated = next(r for r in refetched if r["id"] == rule["id"])
        assert updated["min_phones_staff"] == 5

    def test_patch_zero_is_legal(self, client, seeded_reception):
        rules = client.get("/api/v1/reception/coverage-rules").json()
        rule = rules[0]
        resp = client.patch(
            f"/api/v1/reception/coverage-rules/{rule['id']}",
            json={"min_phones_staff": 0},
        )
        assert resp.status_code == 200
        assert resp.json()["min_phones_staff"] == 0

    def test_patch_negative_422(self, client, seeded_reception):
        rules = client.get("/api/v1/reception/coverage-rules").json()
        rule = rules[0]
        resp = client.patch(
            f"/api/v1/reception/coverage-rules/{rule['id']}",
            json={"min_phones_staff": -1},
        )
        assert resp.status_code == 422

    def test_patch_missing_rule_404(self, client, seeded_reception):
        resp = client.patch(
            "/api/v1/reception/coverage-rules/999999",
            json={"min_phones_staff": 1},
        )
        assert resp.status_code == 404
