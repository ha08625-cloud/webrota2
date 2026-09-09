"""Frontend static mount.

mount_frontend is tested against a fresh FastAPI app and a temp dist dir,
because the production call happens at import time. The rest of the suite
is the standing regression that the main app is unaffected when no dist
exists -- CI never builds a frontend, so every other test runs unmounted.

That asymmetry is why the API-guard tests below exist: the interesting
failures here happen only WITH a dist mounted, which is production and a
developer machine but not CI, so they have to be provoked deliberately
rather than waited for.
"""
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.api.main import mount_frontend


def _make_dist(tmp_path):
    dist = tmp_path / "dist"
    dist.mkdir()
    (dist / "index.html").write_text("<html><body>SPA</body></html>")
    (dist / "app.js").write_text("console.log('hi')")
    # Starts with "api" without being under it -- the segment boundary the
    # mount's API guard has to respect.
    (dist / "apifoo.js").write_text("// static")
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


def test_unmatched_api_paths_404_for_every_method(tmp_path):
    """A miss under /api/* is a 404 whatever the method, not a 405.

    StaticFiles answers anything but GET/HEAD with 405 before it consults
    the path at all, so with a dist mounted an unmatched POST used to get
    405 where the client expects the same JSON 404 it gets unmounted.
    Parametrised over the methods rather than testing POST alone because
    the old behaviour was a property of the method check, so a fix that
    special-cased one verb would be no fix.
    """
    dist = _make_dist(tmp_path)
    application = FastAPI()

    @application.get("/api/v1/ping")
    def ping() -> dict:
        return {"pong": True}

    assert mount_frontend(application, dist) is True
    c = TestClient(application)

    for method in ("GET", "POST", "PUT", "PATCH", "DELETE"):
        resp = c.request(method, "/api/v1/does-not-exist", json={"a": 1})
        assert resp.status_code == 404, f"{method} -> {resp.status_code}"
        assert resp.json() == {"detail": "Not Found"}, method

    # The bare prefix is the API's too, and a path that only LOOKS like one
    # is not: /apifoo.js is a static file.
    assert c.post("/api").status_code == 404
    assert c.get("/apifoo.js").status_code == 200


def test_the_spa_fallback_survives_the_api_guard(tmp_path):
    """The guard must not cost the SPA its deep links.

    A client-side route is served index.html on a hard refresh; a non-GET
    to one still gets StaticFiles' 405, which is correct -- the mount
    genuinely does not accept writes, and only /api/* has a better answer.
    """
    dist = _make_dist(tmp_path)
    application = FastAPI()
    assert mount_frontend(application, dist) is True
    c = TestClient(application)

    deep_link = c.get("/reception/leave")
    assert deep_link.status_code == 200 and "SPA" in deep_link.text
    assert c.post("/reception/leave").status_code == 405
