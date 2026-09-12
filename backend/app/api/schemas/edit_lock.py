"""Edit-lock schemas.

One shape, used by GET /locks and by both writes, so a client that has
acquired a lock and a client that has polled for one are looking at the
same object. `idle` is computed per response rather than stored: staleness
is a judgement about the row made at a moment in time, and the row is
never swept (see models/edit_lock.py). `user_name` is denormalised in
because the banner needs a name and the frontend has no user directory to
resolve an id against.
"""
import datetime

from pydantic import BaseModel


class EditLockOut(BaseModel):
    area: str
    user_id: int
    user_name: str
    acquired_at: datetime.datetime
    last_activity_at: datetime.datetime
    # True when the lock has gone EDIT_LOCK_IDLE_TIMEOUT without an edit and
    # is therefore takeable by the next person who asks. Not a promise that
    # it has been released -- nothing deletes a stale row until someone
    # wants it.
    idle: bool
