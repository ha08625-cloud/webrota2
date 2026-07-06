"""Auth shim tests (M3.5 Task 5).

API_TOKEN unset: everything open (the rest of the suite is the standing
regression for this mode). API_TOKEN set: router endpoints 401 without
or with a wrong X-API-Token and succeed with the right one; /health
stays open. The env var is read per-request, so monkeypatch works
against the shared client fixture.
"""


def test_open_when_env_unset(client, seeded, monkeypatch):
    monkeypatch.delenv("API_TOKEN", raising=False)
    assert client.get("/api/v1/rooms").status_code == 200


def test_401_without_token_when_env_set(client, seeded, monkeypatch):
    monkeypatch.setenv("API_TOKEN", "s3cret")
    resp = client.get("/api/v1/rooms")
    assert resp.status_code == 401


def test_401_with_wrong_token(client, seeded, monkeypatch):
    monkeypatch.setenv("API_TOKEN", "s3cret")
    resp = client.get("/api/v1/rooms", headers={"X-API-Token": "wrong"})
    assert resp.status_code == 401


def test_success_with_token_including_writes(client, seeded, monkeypatch):
    monkeypatch.setenv("API_TOKEN", "s3cret")
    headers = {"X-API-Token": "s3cret"}
    assert client.get("/api/v1/rooms", headers=headers).status_code == 200
    resp = client.post("/api/v1/rota/generate", headers=headers, json={
        "start_date": "2026-01-05", "num_weeks": 1, "template_start_week": 1,
    })
    assert resp.status_code == 200, resp.text


def test_health_open_when_env_set(client, monkeypatch):
    monkeypatch.setenv("API_TOKEN", "s3cret")
    assert client.get("/health").status_code == 200