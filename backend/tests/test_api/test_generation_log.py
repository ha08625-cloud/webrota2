"""GET /rota/{rota_id}/log -- the generation decision log endpoint
(decision-log ticket, Task 4). Complements test_rota.py's TestIssues,
which covers the re-derived /issues endpoint; this covers the
read-persisted-rows /log endpoint instead.
"""
from app.models import GeneratedRota, RotaConfig

from .conftest import MONDAY, generate_rota, make_clinic_type_via_api


class TestGenerationLog:
    def test_404_when_rota_not_found(self, client, seeded):
        resp = client.get("/api/v1/rota/999999/log")
        assert resp.status_code == 404

    def test_empty_list_when_no_log_rows(self, client, db_session, seeded):
        # A rota row created directly, bypassing generate(), has no
        # generation_log rows -- distinct from a generated-but-empty run.
        config = RotaConfig(start_date=MONDAY, num_weeks=1, template_start_week=1)
        db_session.add(config)
        db_session.flush()
        rota = GeneratedRota(config_id=config.id)
        db_session.add(rota)
        db_session.commit()

        resp = client.get(f"/api/v1/rota/{rota.id}/log")
        assert resp.status_code == 200
        assert resp.json() == []

    def test_generated_rota_returns_ordered_entries(self, client, seeded):
        make_clinic_type_via_api(client, seeded)
        out = generate_rota(client)

        resp = client.get(f"/api/v1/rota/{out['rota_id']}/log")
        assert resp.status_code == 200, resp.text
        entries = resp.json()
        assert len(entries) > 0
        # Sequence is monotonic and matches response order.
        sequences = [e["sequence"] for e in entries]
        assert sequences == sorted(sequences)
        assert sequences == list(range(len(entries)))

        # The fixture's clinic assignment shows up with a self-contained
        # message and the plain ids the schema promises (no joins done
        # server-side).
        assert any(e["action"] == "assign_clinic" for e in entries)
        clinic_entry = next(e for e in entries if e["action"] == "assign_clinic")
        assert clinic_entry["phase"] == "phase5"
        assert clinic_entry["doctor_id"] == seeded["doctor_aa"]
        assert isinstance(clinic_entry["message"], str) and clinic_entry["message"]

    def test_works_on_committed_rota(self, client, seeded):
        make_clinic_type_via_api(client, seeded)
        out = generate_rota(client)
        assert client.post(f"/api/v1/rota/{out['rota_id']}/commit").status_code == 200

        resp = client.get(f"/api/v1/rota/{out['rota_id']}/log")
        assert resp.status_code == 200
        assert len(resp.json()) > 0

    def test_rationale_is_persisted_and_returned(self, client, seeded):
        make_clinic_type_via_api(client, seeded)
        out = generate_rota(client)

        resp = client.get(f"/api/v1/rota/{out['rota_id']}/log")
        entries = resp.json()

        clinic_entry = next(e for e in entries if e["action"] == "assign_clinic")
        # The stage-by-stage "why" survives the round trip through
        # rota_generation_log verbatim, newlines and all -- the frontend
        # renders it as written and never parses it.
        rationale = clinic_entry["rationale"]
        assert rationale.startswith("Eligible (")
        assert "\n" in rationale
        assert rationale.rstrip().endswith(".")
        assert "Decided on: " in rationale

    def test_rationale_is_null_where_no_choice_was_made(self, client, seeded):
        make_clinic_type_via_api(client, seeded)
        out = generate_rota(client)

        entries = client.get(f"/api/v1/rota/{out['rota_id']}/log").json()
        # Every entry carries the key, whether or not it has a decision to
        # explain, so the client needs no per-action knowledge.
        assert all("rationale" in e for e in entries)
