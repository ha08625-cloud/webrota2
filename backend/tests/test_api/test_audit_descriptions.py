"""Coverage and behaviour for the audit log's plain-English descriptions.

The point of this file is `test_every_write_route_has_a_description`. The
audit log's readability rests on a hand-written table keyed by
`(method, route)`, and a table like that rots the moment someone adds an
endpoint without touching it. This walks the app's real route tree and
fails with the missing keys spelled out, so the fix is a copy-paste.
"""
from __future__ import annotations

import pytest

from app.api.audit_descriptions import _DESCRIPTIONS, describe, outcome
from app.api.main import app

_SAFE_METHODS = {"GET", "HEAD", "OPTIONS"}


def _write_routes() -> set[tuple[str, str]]:
    """Every (method, router-local path) the app serves for a write.

    FastAPI wraps each `include_router` call in an opaque
    `_IncludedRouter` that keeps the original router rather than copying
    its routes up with the prefix applied -- which is exactly why the
    audit row's `route` is router-local in the first place (see
    app/api/audit.py). Recursing through `original_router` therefore
    yields the same strings the middleware stores.
    """
    found: set[tuple[str, str]] = set()

    def walk(routes) -> None:
        for route in routes:
            included = getattr(route, "original_router", None)
            if included is not None:
                walk(included.routes)
                continue
            for method in getattr(route, "methods", None) or ():
                if method not in _SAFE_METHODS:
                    found.add((method, route.path))

    walk(app.routes)
    return found


def test_route_walk_finds_known_endpoints():
    """Guards the walk itself: if a FastAPI upgrade changes the route tree
    so nothing is found, the coverage test below would pass vacuously."""
    routes = _write_routes()
    assert ("POST", "/rota/{rota_id}/commit") in routes
    assert ("PATCH", "/doctors/{doctor_id}") in routes
    assert len(routes) > 50


def test_every_write_route_has_a_description():
    missing = sorted(_write_routes() - set(_DESCRIPTIONS), key=lambda k: (k[1], k[0]))
    assert not missing, (
        "These write endpoints have no plain-English description, so the "
        "audit log will show a raw method and route for them. Add an entry "
        "to _DESCRIPTIONS in app/api/audit_descriptions.py:\n"
        + "\n".join(f'    ("{m}", "{p}"): "...",' for m, p in missing)
    )


def test_no_stale_descriptions():
    """The reverse: an entry for a route that no longer exists is dead
    weight that reads as coverage it does not provide."""
    stale = sorted(set(_DESCRIPTIONS) - _write_routes(), key=lambda k: (k[1], k[0]))
    assert not stale, f"_DESCRIPTIONS names routes the app does not serve: {stale}"


def test_descriptions_are_sentences_not_paths():
    for (method, route), text in _DESCRIPTIONS.items():
        assert text and text[0].isupper(), f"{method} {route}: should start capitalised"
        assert "/" not in text.replace("{", "").replace("}", ""), (
            f"{method} {route}: a description should read as English, not a path"
        )


def test_describe_substitutes_path_params():
    assert describe(
        "PATCH", "/rota/{rota_id}/sessions/{session_id}", {"rota_id": "12"}
    ) == "Changed a session in rota 12"


def test_describe_renders_a_missing_path_param_rather_than_raising():
    # path_params is nullable on the row, so a template placeholder can
    # have nothing behind it; a KeyError here would 500 the whole page.
    assert describe("POST", "/rota/{rota_id}/commit", None) == "Committed rota ?"


def test_describe_falls_back_to_method_and_route_when_unmapped():
    assert describe("POST", "/not/a/real/route") == "POST /not/a/real/route"


def test_describe_handles_a_request_that_matched_no_route():
    # A 404 has route=None; the row still has to render.
    assert describe("DELETE", None) == "DELETE (unknown page)"


@pytest.mark.parametrize(
    "status,expected",
    [
        (200, "Done"),
        (201, "Done"),
        (204, "Done"),
        (302, "Done"),
        (400, "Rejected"),
        (401, "Not allowed"),
        (403, "Not allowed"),
        (404, "Not found"),
        (409, "Rejected"),
        (422, "Rejected"),
        (500, "System error"),
        (0, "Unknown"),
    ],
)
def test_outcome_buckets(status, expected):
    assert outcome(status) == expected
