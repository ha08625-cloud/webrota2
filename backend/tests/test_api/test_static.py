"""Frontend static mount (M3.5 Task 6).

mount_frontend is tested against a fresh FastAPI app and a temp dist dir,
because the production call happens at import time. The existing suite is
the standing regression that the main app is unaffected when no dist
exists (no frontend build is present in CI).
"""
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.api.main import mount_frontend


def _make_dist(tmp_path):
    dist = tmp_path / "dist"
    dist.mkdir()
    (dist / "index.html").write_text("<html><body>SPA</body></html>")
    (dist / "app.js").write_text("console.log('hi')")
    return dist


def test_no_mount_when_dist_missing(tmp_path):
    application = FastAPI()
    assert mount_frontend(application, tmp_path / "nope") is False


def test_no_mount_without_index_html(tmp_path):
    empty = tmp_path / "dist"
    empty.mkdir()
    application = FastAPI()
    assert mount_frontend(application, empty) is False


def test_spa_serving_and_api_precedence(tmp_path):
    dist = _make_dist(tmp_path)
    application = FastAPI()

    @application.get("/api/v1/ping")
    def ping() -> dict:
        return {"pong": True}

    assert mount_frontend(application, dist) is True
    c = TestClient(application)

    # Real file and root index.
    assert c.get("/app.js").status_code == 200
    root = c.get("/")
    assert root.status_code == 200 and "SPA" in root.text

    # SPA fallback: unknown client-side route serves index.html.
    fallback = c.get("/rota/history/3")
    assert fallback.status_code == 200 and "SPA" in fallback.text

    # API routes win over the mount; unknown API paths stay real 404s.
    assert c.get("/api/v1/ping").status_code == 200
    assert c.get("/api/v1/does-not-exist").status_code == 404