"""EditLock: one section editing lock per lockable area (edit lock plan).

The model is a Word document on a shared drive. The first login with write
access to enter a section holds the lock; everyone else is downgraded to
read-only in that section until it is released. Reading is never blocked.
At most two rows ever exist -- one for `clinical`, one for `reception` --
which is structural rather than enforced by a trigger: `area` is the
primary key.

Two facts about the timer, both load-bearing:

1. `last_activity_at` measures *edits*, not browsers. It is stamped by
   writes that pass the lock gate and by nothing else -- there is no
   heartbeat, no ping, and an open tab does not keep a lock alive. That is
   what makes the absence of a force-takeover button safe: the idle timeout
   is the only route back into a section someone walked away from, so it
   must not be defeatable by leaving a page open.

2. Staleness is *evaluated*, never swept. A lock idle for longer than
   EDIT_LOCK_IDLE_TIMEOUT is takeable, not automatically deleted: the
   holder keeps it indefinitely while nobody else asks, so they never lose
   it to an empty room, and the row is only replaced at the moment another
   user tries to enter or write. `is_stale` therefore reads and returns --
   it must stay side-effect-free, because the lock poll calls it on every
   request and polling must not mutate anything.

EDIT_LOCK_IDLE_TIMEOUT lives here rather than in models/permissions.py,
which also holds LOCKABLE_AREAS: the area list is part of the permission
*shape* and is shared with the schemas, the seed script and the migration,
whereas the timeout is lock *behaviour* and means nothing without the
semantics `is_stale` gives it. Keeping the two together means a reader of
the timeout can see, in the same file, that it is measured from the last
edit and consulted only on demand.
"""
import datetime

from sqlalchemy import DateTime, ForeignKey, Integer, String
from sqlalchemy.orm import Mapped, mapped_column

from ..database import Base

# How long a lock must go without an edit before another user may take it.
# This figure is also written into the sentence a locked-out user reads --
# frontend/src/components/EditLockBanner.tsx, IDLE_TIMEOUT_PHRASE -- since
# "when does this free up?" is the only question they have. There is no
# codegen between the two halves of the app, so changing it here means
# changing that phrase too.
EDIT_LOCK_IDLE_TIMEOUT = datetime.timedelta(minutes=15)


def as_utc(value: datetime.datetime) -> datetime.datetime:
    """Read a timestamp column back as an aware UTC datetime.

    SQLite does not round-trip tzinfo on DateTime(timezone=True), so a row
    written aware comes back naive and comparing it against an aware `now`
    raises TypeError. Everything written to these columns is UTC, so
    treating a naive read as UTC is correct on Postgres too rather than a
    SQLite patch. The same fix appears in api/deps.py (session expiry) and
    api/routers/auth.py (reset-token expiry).
    """
    return (
        value
        if value.tzinfo is not None
        else value.replace(tzinfo=datetime.timezone.utc)
    )


class EditLock(Base):
    __tablename__ = "edit_locks"

    # The permission area the lock covers -- one of permissions.LOCKABLE_AREAS.
    # It is the primary key, which is what guarantees at most one lock per
    # section without any uniqueness logic in the router. Stored as a plain
    # string rather than a DB enum, so adding a lockable section later is a
    # code change and not a migration; the allowed values are enforced in
    # application code.
    area: Mapped[str] = mapped_column(String, primary_key=True)
    # The holder. No ON DELETE CASCADE: users are deactivated rather than
    # deleted in this schema, so a lock row whose user has vanished should
    # be a visible problem rather than a silent disappearance.
    user_id: Mapped[int] = mapped_column(
        Integer, ForeignKey("users.id"), nullable=False
    )
    acquired_at: Mapped[datetime.datetime] = mapped_column(
        DateTime(timezone=True),
        nullable=False,
        default=lambda: datetime.datetime.now(datetime.timezone.utc),
    )
    # Stamped by edits only -- see the module docstring.
    last_activity_at: Mapped[datetime.datetime] = mapped_column(
        DateTime(timezone=True),
        nullable=False,
        default=lambda: datetime.datetime.now(datetime.timezone.utc),
    )

    def __repr__(self) -> str:  # pragma: no cover
        return f"<EditLock {self.area} user={self.user_id}>"


def is_stale(lock: EditLock, now: datetime.datetime) -> bool:
    """True when `lock` has gone EDIT_LOCK_IDLE_TIMEOUT without an edit.

    Pure: being stale makes a lock takeable, it does not delete it. `now`
    is passed in rather than read here so that callers evaluating several
    locks judge them all against one instant, and so tests need no clock
    patching.
    """
    return as_utc(lock.last_activity_at) + EDIT_LOCK_IDLE_TIMEOUT <= now
