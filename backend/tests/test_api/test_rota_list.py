"""GET /rota list endpoint (M3.5 Task 1).

Covers: empty list; summary fields match the generated rota; a committed
rota plus a newer draft come back newest-first with correct statuses.
Uses the shared conftest fixtures (seeded) and generate_rota helper.
"""
import datetime

from .conftest import MONDAY, generate_rota


def test_list_empty(client, seeded):
    resp = client.get("/api/v1/rota")
    assert resp.status_code == 200
    assert resp.json() == []


def test_list_single_draft_fields(client, seeded):
    gen = generate_rota(client, num_weeks=1)

    resp = client.get("/api/v1/rota")
    assert resp.status_code == 200
    body = resp.json()
    assert len(body) == 1
    summary = body[0]
    assert summary["rota_id"] == gen["rota_id"]
    assert summary["status"] == "draft"
    assert summary["start_date"] == MONDAY.isoformat()
    assert summary["num_weeks"] == 1
    assert summary["template_start_week"] == 1
    assert "created_at" in summary
    assert summary["archived_at"] is None
    # Summary only -- no session payload in the list view.
    assert "sessions" not in summary


def test_list_committed_and_draft_newest_first(client, seeded):
    first = generate_rota(client, num_weeks=1)
    resp = client.post(f"/api/v1/rota/{first['rota_id']}/commit")
    assert resp.status_code == 200, resp.text

    # A different week -- generating over the same week as the now-committed
    # rota is rejected (409), by design.
    second = generate_rota(
        client, num_weeks=1, start_date=MONDAY + datetime.timedelta(days=7)
    )

    resp = client.get("/api/v1/rota")
    assert resp.status_code == 200
    body = resp.json()
    assert [r["rota_id"] for r in body] == [second["rota_id"], first["rota_id"]]
    assert [r["status"] for r in body] == ["draft", "committed"]