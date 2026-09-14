"""Section editing locks: read them, take one, give it back.

Two locks exist at most -- one for `clinical`, one for `reception` -- and
the model is a Word document on a shared drive. The first login with write
access to enter a section holds it; everyone else is downgraded to
read-only there until it is released. Reading is never blocked, for
anyone, ever: this router refuses acquisitions, never reads of the section
itself.

This router is in main.py's `_UNGATED` tuple and gates itself per endpoint,
which is the `users.py` arrangement and needs the same justification.
`require_access` is built once per router around ONE area, and this router
has no single area: the area it acts on arrives as a path parameter and may
be either lockable section, so a registration-time gate would have to pick
one and would then either 403 half the legitimate calls or wave through
half the illegitimate ones. Each endpoint therefore calls
`deps.require_area_write` with the area it was actually given, raising the
same 403s with the same wording as the factory would. **A new endpoint in
this file is UNGATED until somebody adds that call** --
tests/test_api/test_authorization.py sweeps this router's own routes
against a no-permission login to catch the omission, but the default-deny
property the rest of the API has does not hold here.

Three things this router deliberately does not do:

- **It never sweeps.** A stale lock is takeable, not gone. GET /locks
  reports `idle` and deletes nothing, so the banner can poll it every few
  seconds with no side effects, and a holder in an empty room keeps their
  lock indefinitely rather than losing it to a background job.
- **Re-acquiring does not bump `last_activity_at`.** Entering a section is
  not editing. Bumping here would let anyone hold a section for as long as
  they kept navigating in and out of it, which is exactly the defeat the
  idle timer exists to prevent (see models/edit_lock.py).
- **It is not what makes locks binding.** These endpoints only record and
  report an intention; enforcement is `require_edit_lock` (api/deps.py),
  added to every lockable router by main.py's registration loop. A write
  that never calls POST /locks is still gated, and one that acquires
  successfully is still checked again on every write.

Releasing a lock you do not hold is 204, not 404. Every caller fires this
on *leaving* a section -- the provider unmount, the logout path, and a
`keepalive` DELETE on page hide, which cannot read a response at all -- so
"release whatever I have here, if anything" is the only thing the call can
usefully mean, and a 404 would be an error nobody is listening for. The
same call from someone whose lock expired and was taken must not delete the
new holder's row, so the delete is conditional on the holder being the
caller.
"""
from __future__ import annotations

import datetime

from fastapi import APIRouter, Depends, HTTPException, Response
from sqlalchemy import select
from sqlalchemy.orm import Session

from ...models import EditLock, User, is_stale
from ...models.edit_lock import as_utc
from ...models.permissions import LOCKABLE_AREAS, can_read_area
from ..deps import get_current_user, get_db, require_area_write
from ..edit_lock import edit_lock_conflict
from ..schemas import EditLockOut

router = APIRouter(prefix="/locks", tags=["locks"])


def _validate_area(area: str) -> str:
    """422 for an area that cannot hold a lock.

    Checked BEFORE the permission gate, which is what makes
    `POST /locks/{area}` answer 422 rather than 403 for a nonsense area:
    "that is not a section" is a fact about the request, not about the
    caller, and answering 403 would make the authorization sweeps in
    test_authorization.py (which substitute "1" for every path param) read
    a validation failure as a gate doing its job.
    """
    if area not in LOCKABLE_AREAS:
        raise HTTPException(
            status_code=422,
            detail=f"Not a lockable section: {area!r}",
        )
    return area


def _out(lock: EditLock, holder_name: str, now: datetime.datetime) -> EditLockOut:
    """The wire shape of one lock.

    Both timestamps go through `as_utc` rather than straight out of the
    column. SQLite hands DateTime(timezone=True) back naive, and an ISO
    string with no offset is parsed as LOCAL time by `new Date()` in the
    browser -- so the banner's "started 20 minutes ago" would be wrong by
    the viewer's UTC offset in development and right on Postgres. Both
    columns are written UTC, so this is the correct reading everywhere,
    not a SQLite patch (see models/edit_lock.py).
    """
    return EditLockOut(
        area=lock.area,
        user_id=lock.user_id,
        user_name=holder_name,
        acquired_at=as_utc(lock.acquired_at),
        last_activity_at=as_utc(lock.last_activity_at),
        idle=is_stale(lock, now),
    )


@router.get("", response_model=list[EditLockOut])
def list_locks(
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
) -> list[EditLockOut]:
    """Every current lock the caller is allowed to know about.

    Filtered by the caller's READ level, not their write level: a
    reception-only login has no business learning who is in the clinical
    rota, while a login that can read a section needs the banner even
    though it will never hold the lock itself. That filter is this
    endpoint's gate -- there is no 403 path, because "no locks you can see"
    and "no locks" are the same empty list and the difference is not worth
    leaking.

    One instant (`now`) judges every row, so two locks in one response are
    never reported against two different clocks.
    """
    permissions = user.permissions or {}
    visible = [area for area in LOCKABLE_AREAS if can_read_area(permissions, area)]
    if not visible:
        return []

    now = datetime.datetime.now(datetime.timezone.utc)
    rows = db.execute(
        select(EditLock, User.name)
        .join(User, User.id == EditLock.user_id)
        .where(EditLock.area.in_(visible))
        .order_by(EditLock.area)
    ).all()
    return [_out(lock, holder_name, now) for lock, holder_name in rows]


@router.post("/{area}", response_model=EditLockOut)
def acquire_lock(
    area: str,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
) -> EditLockOut:
    """Take the lock on `area`, or say who has it.

    Four cases, and the middle two are the ones worth stating: the caller
    already holding it is a no-op that returns the row UNCHANGED (see the
    module docstring on why `last_activity_at` is not bumped), and another
    user holding it idle means their row is deleted and replaced here and
    now -- staleness is evaluated at the moment somebody else asks, which
    is the only moment it matters.
    """
    _validate_area(area)
    require_area_write(area, user)

    now = datetime.datetime.now(datetime.timezone.utc)
    lock = db.get(EditLock, area)

    if lock is not None and lock.user_id == user.id:
        return _out(lock, user.name, now)

    if lock is not None:
        holder = db.get(User, lock.user_id)
        # A holder whose user row has vanished cannot be named, and the
        # lock cannot be honoured on their behalf -- treat it as takeable
        # rather than 500ing or blocking the section forever.
        if holder is not None and not is_stale(lock, now):
            raise edit_lock_conflict(lock, holder.name)
        db.delete(lock)
        db.flush()

    lock = EditLock(area=area, user_id=user.id, acquired_at=now, last_activity_at=now)
    db.add(lock)
    db.commit()
    db.refresh(lock)
    return _out(lock, user.name, now)


@router.delete("/{area}", status_code=204)
def release_lock(
    area: str,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
) -> Response:
    """Give back the lock on `area`. Always 204 -- see the module docstring.

    Gated on write access like the acquire, so that the only login that can
    touch a lock row is one that could have created it. The narrow cost is
    that a holder whose permission is lowered to read while they hold a
    lock can no longer release it; the 15-minute idle timeout is the answer
    there, as it is for every other way a holder can stop asking.
    """
    _validate_area(area)
    require_area_write(area, user)

    lock = db.get(EditLock, area)
    # Conditional on the holder: a beacon from a tab whose lock expired and
    # was taken by someone else must not release the new holder's lock.
    if lock is not None and lock.user_id == user.id:
        db.delete(lock)
        db.commit()
    return Response(status_code=204)
