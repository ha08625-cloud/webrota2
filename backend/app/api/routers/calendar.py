"""The public per-doctor `.ics` feed -- the ONLY unauthenticated endpoint in
the app (calendar feed plan, Task 3).

Everything else behind /api/v1 requires a valid session (see api/deps.py).
This router is the one deliberate exception, and it is a separate module
containing exactly one GET so that the hole cannot widen by accident.

Why it cannot be authenticated: a calendar client -- Google, Outlook, Apple
Calendar -- fetches the URL on its own schedule with no way to present a
bearer token. **The token in the path IS the credential.** It is 256 bits
from `secrets.token_urlsafe` behind a unique index, and each feed carries
exactly one doctor, so a leaked URL exposes one person's working pattern
rather than the practice's. Rotation (manager-only, on the doctors router)
is the revocation path.

Why the router is in main.py's `_UNGATED`: `require_write_access` is itself
declared `user: User = Depends(get_current_user)`, so the global gate 401s
an unauthenticated request BEFORE it ever reaches the method check. A
GET-only router registered in the normal loop would therefore still demand
a session. `_UNGATED` is the only way out, and this router is the third and
last entry in it.

**Do not add a non-GET endpoint to this router.** It would be both
unauthenticated and unauthorized -- world-writable. That is not left to
review: `tests/test_api/test_authorization.py`'s sweep enumerates every
non-GET route in the OpenAPI schema and asserts 403 for a viewer, and this
router is not in its exemptions, so such an endpoint fails that test on the
first run. The mirror-image sweep in the same file asserts 401 for every
GET, with this one path as its single explicit allowlist entry.

Token management (read and rotate) lives on the authenticated, write-gated
doctors router, never here. That router composes the feed's path through
`feed_path()` below rather than spelling it out again, so the URL has one
definition.
"""
from __future__ import annotations

import datetime

from fastapi import APIRouter, Depends, HTTPException, Response
from sqlalchemy import select
from sqlalchemy.orm import Session

from ...calendar_feed import build_feed
from ...models import Doctor
from ..deps import get_db

router = APIRouter(prefix="/calendar", tags=["calendar"])

_NOT_FOUND_DETAIL = "Calendar feed not found"


def feed_path(token: str) -> str:
    """The app-relative path of one doctor's feed, e.g. `/api/v1/calendar/x.ics`.

    Derived from the route itself (prefix, param and `.ics` suffix all come
    out of `url_path_for`) so the doctors router cannot drift from what this
    module actually serves.

    Returns a path, never an absolute URL: the frontend prepends
    `window.location.origin`. Building the absolute form here would mean
    reading `request.base_url`, which behind Railway's proxy reports whatever
    the proxy forwarded -- a scheme mismatch there yields an `http://` URL
    that a subscriber pastes into Google and that silently fails. The browser
    already knows its own origin correctly in dev and production alike.

    `API_PREFIX` is imported inside the function on purpose: `api/main.py`
    imports this module to register the router, so a module-level import
    would be circular.
    """
    from ..main import API_PREFIX

    return f"{API_PREFIX}{router.url_path_for('calendar_feed', token=token)}"


@router.get("/{token}.ics")
def calendar_feed(token: str, db: Session = Depends(get_db)) -> Response:
    """Serve one doctor's committed sessions as iCalendar bytes.

    The literal `.ics` suffix parses unambiguously despite the greedy path
    param: `secrets.token_urlsafe` emits only `[A-Za-z0-9_-]`, so the token
    cannot swallow the dot. The suffix is there because several desktop
    clients decide how to handle a URL by its extension.

    An unknown token 404s with a generic detail -- never distinguishing "no
    such token" from "rotated" from "inactive doctor", which would turn the
    endpoint into an oracle.

    A soft-deleted (`active=False`) doctor STILL serves their feed, on
    purpose: deactivation is not revocation -- rotation is -- and a leaver's
    committed past sessions are real history their calendar should keep.
    Do not "fix" this by filtering on `active`.
    """
    doctor = db.execute(
        select(Doctor).where(Doctor.calendar_token == token)
    ).scalar_one_or_none()
    if doctor is None:
        raise HTTPException(status_code=404, detail=_NOT_FOUND_DETAIL)

    content = build_feed(db, doctor, datetime.date.today())
    return Response(
        content=content,
        media_type="text/calendar; charset=utf-8",
        headers={"Content-Disposition": 'inline; filename="rota.ics"'},
    )
