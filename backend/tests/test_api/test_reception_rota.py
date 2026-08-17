"""Reception day rota router tests (reception rota, Task 4)."""
import datetime

from .conftest import MONDAY

TUESDAY = MONDAY + datetime.timedelta(days=1)
SATURDAY = MONDAY + datetime.timedelta(days=5)

ROTA_URL = "/api/v1/reception/rota"


def _add_template_session(client, staff_id, day, hour, role="phones", note=None):
    resp = client.post("/api/v1/reception/master/sessions", json={
        "staff_id": staff_id, "day": day, "hour": hour, "role": role, "note": note,
    })
    assert resp.status_code == 201, resp.text
    return resp.json()


class TestReceptionRotaGenerate:
    def test_generate_copies_active_staff_only(self, client, seeded_reception):
        ra, rb, rd = (
            seeded_reception["staff_ra"],
            seeded_reception["staff_rb"],
            seeded_reception["staff_rd_inactive"],
        )
        _add_template_session(client, ra, "Monday", 9, role="phones")
        _add_template_session(client, rb, "Monday", 9, role="other", note="training")
        _add_template_session(client, rd, "Monday", 9, role="phones")

        resp = client.post(ROTA_URL, json={"date": MONDAY.isoformat()})
        assert resp.status_code == 201, resp.text
        body = resp.json()
        assert body["date"] == MONDAY.isoformat()
        assert len(body["sessions"]) == 2
        by_code = {s["staff_code"]: s for s in body["sessions"]}
        assert set(by_code) == {"RA", "RB"}
        assert by_code["RA"]["role"] == "phones"
        assert by_code["RA"]["note"] is None
        assert by_code["RB"]["role"] == "other"
        assert by_code["RB"]["note"] == "training"

    def test_weekend_422(self, client, seeded_reception):
        resp = client.post(ROTA_URL, json={"date": SATURDAY.isoformat()})
        assert resp.status_code == 422

    def test_duplicate_date_409(self, client, seeded_reception):
        first = client.post(ROTA_URL, json={"date": MONDAY.isoformat()})
        assert first.status_code == 201
        second = client.post(ROTA_URL, json={"date": MONDAY.isoformat()})
        assert second.status_code == 409
        assert str(first.json()["rota_id"]) in second.json()["detail"]

    def test_delete_then_regenerate_succeeds(self, client, seeded_reception):
        first = client.post(ROTA_URL, json={"date": MONDAY.isoformat()}).json()
        resp = client.delete(f"{ROTA_URL}/{first['rota_id']}")
        assert resp.status_code == 204

        second = client.post(ROTA_URL, json={"date": MONDAY.isoformat()})
        assert second.status_code == 201

    def test_empty_day_warns_every_hour(self, client, seeded_reception):
        # MIN_PHONES_STAFF is a flat constant checked every hour of every
        # weekday, so an empty day (no template rows for Tuesday) is short
        # at every slot, not silently satisfied.
        resp = client.post(ROTA_URL, json={"date": TUESDAY.isoformat()})
        assert resp.status_code == 201
        body = resp.json()
        assert body["sessions"] == []
        assert len(body["issues"]) == 22
        assert all(i["check"] == "phones_shortfall" for i in body["issues"])
        assert all("0 staff on phones, 2 required" in i["message"] for i in body["issues"])


class TestReceptionRotaLookup:
    def test_get_by_date_404_before_generate(self, client, seeded_reception):
        resp = client.get(ROTA_URL, params={"date": MONDAY.isoformat()})
        assert resp.status_code == 404

    def test_get_by_date_after_generate(self, client, seeded_reception):
        generated = client.post(ROTA_URL, json={"date": MONDAY.isoformat()}).json()
        resp = client.get(ROTA_URL, params={"date": MONDAY.isoformat()})
        assert resp.status_code == 200
        assert resp.json()["rota_id"] == generated["rota_id"]

    def test_get_by_id(self, client, seeded_reception):
        generated = client.post(ROTA_URL, json={"date": MONDAY.isoformat()}).json()
        resp = client.get(f"{ROTA_URL}/{generated['rota_id']}")
        assert resp.status_code == 200
        assert resp.json()["date"] == MONDAY.isoformat()

    def test_get_by_id_404(self, client, seeded_reception):
        resp = client.get(f"{ROTA_URL}/999999")
        assert resp.status_code == 404


class TestReceptionRotaCoverage:
    def test_shortfall_warning_appears_and_clears(self, client, seeded_reception):
        ra, rb = seeded_reception["staff_ra"], seeded_reception["staff_rb"]
        # MIN_PHONES_STAFF is a flat 2 for every hour.
        _add_template_session(client, ra, "Monday", 9, role="phones")

        generated = client.post(ROTA_URL, json={"date": MONDAY.isoformat()}).json()
        issues = generated["issues"]
        hour9 = [i for i in issues if i["message"].startswith("09:00")]
        assert len(hour9) == 1
        assert hour9[0]["severity"] == "warning"
        assert hour9[0]["phase"] == "coverage"
        assert hour9[0]["check"] == "phones_shortfall"
        assert hour9[0]["day"] == "Monday"
        assert "1 staff on phones, 2 required" in hour9[0]["message"]

        add_resp = client.post(f"{ROTA_URL}/{generated['rota_id']}/sessions", json={
            "staff_id": rb, "hour": 9, "role": "phones",
        })
        assert add_resp.status_code == 201, add_resp.text
        remaining = add_resp.json()["issues"]
        assert not any(i["message"].startswith("09:00") for i in remaining)

    def test_other_role_does_not_count_towards_phones(self, client, seeded_reception):
        ra, rb, rc = (
            seeded_reception["staff_ra"],
            seeded_reception["staff_rb"],
            seeded_reception["staff_rc"],
        )
        for staff_id in (ra, rb, rc):
            _add_template_session(client, staff_id, "Monday", 9, role="other")

        generated = client.post(ROTA_URL, json={"date": MONDAY.isoformat()}).json()
        hour9 = [i for i in generated["issues"] if i["message"].startswith("09:00")]
        assert len(hour9) == 1
        assert "0 staff on phones, 2 required" in hour9[0]["message"]


class TestReceptionRotaSessions:
    def test_post_session_unknown_staff_404(self, client, seeded_reception):
        generated = client.post(ROTA_URL, json={"date": MONDAY.isoformat()}).json()
        resp = client.post(f"{ROTA_URL}/{generated['rota_id']}/sessions", json={
            "staff_id": 999999, "hour": 9,
        })
        assert resp.status_code == 404

    def test_post_session_duplicate_slot_409(self, client, seeded_reception):
        generated = client.post(ROTA_URL, json={"date": MONDAY.isoformat()}).json()
        payload = {"staff_id": seeded_reception["staff_ra"], "hour": 9}
        first = client.post(f"{ROTA_URL}/{generated['rota_id']}/sessions", json=payload)
        assert first.status_code == 201
        second = client.post(f"{ROTA_URL}/{generated['rota_id']}/sessions", json=payload)
        assert second.status_code == 409

    def test_post_session_returns_session_and_issues(self, client, seeded_reception):
        generated = client.post(ROTA_URL, json={"date": MONDAY.isoformat()}).json()
        resp = client.post(f"{ROTA_URL}/{generated['rota_id']}/sessions", json={
            "staff_id": seeded_reception["staff_ra"], "hour": 11, "note": "post",
        })
        assert resp.status_code == 201
        body = resp.json()
        assert body["session"]["staff_code"] == "RA"
        assert body["session"]["hour"] == 11
        assert body["session"]["role"] == "phones"
        assert body["session"]["note"] == "post"
        assert "issues" in body

    def test_patch_session_pair_setter_returns_issues(self, client, seeded_reception):
        generated = client.post(ROTA_URL, json={"date": MONDAY.isoformat()}).json()
        created = client.post(f"{ROTA_URL}/{generated['rota_id']}/sessions", json={
            "staff_id": seeded_reception["staff_ra"], "hour": 11,
        }).json()["session"]

        resp = client.patch(
            f"{ROTA_URL}/{generated['rota_id']}/sessions/{created['session_id']}",
            json={"role": "other", "note": "training"},
        )
        assert resp.status_code == 200
        body = resp.json()
        assert body["session"]["role"] == "other"
        assert body["session"]["note"] == "training"
        assert "issues" in body

    def test_patch_session_missing_404(self, client, seeded_reception):
        generated = client.post(ROTA_URL, json={"date": MONDAY.isoformat()}).json()
        resp = client.patch(
            f"{ROTA_URL}/{generated['rota_id']}/sessions/999999",
            json={"role": "phones", "note": None},
        )
        assert resp.status_code == 404

    def test_delete_session_is_absence_mechanism(self, client, seeded_reception):
        ra, rb = seeded_reception["staff_ra"], seeded_reception["staff_rb"]
        _add_template_session(client, ra, "Monday", 9, role="phones")
        _add_template_session(client, rb, "Monday", 9, role="phones")

        generated = client.post(ROTA_URL, json={"date": MONDAY.isoformat()}).json()
        session_id = next(
            s["session_id"] for s in generated["sessions"] if s["staff_code"] == "RA"
        )

        resp = client.delete(
            f"{ROTA_URL}/{generated['rota_id']}/sessions/{session_id}"
        )
        assert resp.status_code == 204

        refetched = client.get(f"{ROTA_URL}/{generated['rota_id']}").json()
        assert {s["staff_code"] for s in refetched["sessions"]} == {"RB"}
        hour9 = [i for i in refetched["issues"] if i["message"].startswith("09:00")]
        assert "1 staff on phones, 2 required" in hour9[0]["message"]

    def test_delete_session_missing_404(self, client, seeded_reception):
        generated = client.post(ROTA_URL, json={"date": MONDAY.isoformat()}).json()
        resp = client.delete(f"{ROTA_URL}/{generated['rota_id']}/sessions/999999")
        assert resp.status_code == 404

    def test_delete_rota_cascades_sessions(self, client, seeded_reception):
        _add_template_session(client, seeded_reception["staff_ra"], "Monday", 9)
        generated = client.post(ROTA_URL, json={"date": MONDAY.isoformat()}).json()
        resp = client.delete(f"{ROTA_URL}/{generated['rota_id']}")
        assert resp.status_code == 204
        assert client.get(f"{ROTA_URL}/{generated['rota_id']}").status_code == 404
