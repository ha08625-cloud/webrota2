"""The section editing lock's API-side vocabulary: the 409 it raises.

A module of its own rather than a helper inside routers/locks.py, for one
structural reason. `require_edit_lock` (api/deps.py), the dependency that
enforces a lock on every clinical and reception write, must raise the SAME
409 body that POST /locks/{area} raises -- one shape, defined once, so the
frontend has one thing to parse. That
dependency's natural home is next to the other gates in api/deps.py, but
routers/locks.py imports api/deps.py (get_db, get_current_user), so
defining the helper in the router would make deps -> routers.locks ->
deps a circular import at load time. Both sides import it from here
instead.

The refusal is 409 and not 401, 403 or 423, and each of those is a
decision:

  401  frontend/src/api/client.ts fires the global unauthorized listener on
       ANY 401 and bounces the user to the login form. Being second into a
       section must never log anyone out.
  403  means "never", which is what the permission gates say. A lock means
       "not right now, and probably in a few minutes" -- a different
       sentence for the person reading the toast, and one that would
       otherwise be indistinguishable from losing a permission.
  423  is the technically apt code, but every other state-conflict refusal
       in these routers (_require_draft, the staging singleton) answers
       409, and consistency across the API is worth more here than
       precision no client acts on.

`code` is in the body so the frontend can tell a lock 409 from those other
409s without matching on the message text.
"""
from __future__ import annotations

import datetime

from fastapi import HTTPException

from ..models import EditLock
from ..models.edit_lock import as_utc

# How each lockable area is named in the sentence the user reads. Matches
# the phrasing of deps._FORBIDDEN_DETAIL ("the clinical rota"), so the two
# refusals a user can meet in the same section read as one voice.
_AREA_PHRASE = {
    "clinical": "the clinical rota",
    "reception": "the reception rota",
}

# The discriminator the frontend matches on. A constant rather than a
# literal at each raise site, because it is the contract.
EDIT_LOCK_HELD = "edit_lock_held"


def _isoformat(value: datetime.datetime | None) -> str | None:
    """A timestamp column as an ISO string the JSON encoder need not guess
    at. `None` never happens for a persisted lock (both columns are NOT
    NULL); it is tolerated so a half-built row cannot turn a 409 into a
    500.

    `as_utc` first, and it is not cosmetic: SQLite hands these columns back
    naive, and an ISO string with no offset is parsed as LOCAL time by
    `new Date()` in the browser. The banner reads this timestamp to say how
    long ago the holder started, so a naive string would make it wrong by
    the viewer's UTC offset in development while being right on Postgres --
    the worst shape of bug to find later.
    """
    return None if value is None else as_utc(value).isoformat()


def edit_lock_conflict(lock: EditLock, holder_name: str) -> HTTPException:
    """The 409 for "somebody else is in this section".

    Returned rather than raised, so the call site reads `raise
    edit_lock_conflict(...)` and a reader can see where the request stops.
    `holder_name` is passed in rather than looked up here. EditLock
    carries a plain `user_id` and no relationship, and every caller has
    already loaded the holder's row to decide there was a conflict at all,
    so resolving the name here would be a second SELECT on a path that runs
    on every blocked write.
    """
    return HTTPException(
        status_code=409,
        detail={
            "message": f"{holder_name} is editing {_AREA_PHRASE[lock.area]}",
            "code": EDIT_LOCK_HELD,
            "area": lock.area,
            "holder_user_id": lock.user_id,
            "holder_name": holder_name,
            "acquired_at": _isoformat(lock.acquired_at),
            "last_activity_at": _isoformat(lock.last_activity_at),
        },
    )
