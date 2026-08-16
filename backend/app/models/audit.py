"""Audit log: one row per write request that reaches the API.

`AuditLogEntry` records who made a non-GET request, which route it hit,
what they sent, and what came back. Its purpose is debugging -- being able
to reconstruct "the rota looks wrong, what happened to it?" from the
sequence of requests that touched it -- not compliance, so it records HTTP
shape (method, route, status, body) rather than field-level before/after
diffs.

Rows are written **only** by the audit middleware, in its own session and
its own transaction, after the endpoint has already committed. There is no
write API for this table: no router creates, edits or deletes rows, and
nothing is ever pruned. The single reader is a manager-only list endpoint.

Two conventions follow from that:

1. `user_email` and `user_access_level` are **frozen snapshots**, copied in
   at write time rather than joined from `users` at read time, so an entry
   still reads correctly after the user is renamed or demoted (the same
   "frozen prose, never re-derived" convention as
   `RotaGenerationLogEntry`). `user_access_level` is a plain `String` and
   deliberately **not** `enum_col(AccessLevel)`: a native Postgres enum
   would turn any future tier rename or removal into a migration against
   historical rows that are, by definition, meant to be immutable, and it
   would put a `DROP TYPE` in the migration's `downgrade()`.

   `user_id` does carry a real FK to `users.id`, unlike
   `RotaGenerationLogEntry`'s deliberately FK-free ids: there is no delete
   endpoint for users and they are never hard-deleted, so the FK adds no
   delete-blocker surface. It is nullable, for requests with no
   authenticated actor (a failed login, a 401).

2. `route` is the templated path as the ASGI scope reports it, which is
   **router-local**: `/rota/{rota_id}/sessions/{session_id}`, with no
   `/api/v1` prefix, because `include_router(prefix=...)` prefixes are not
   part of `route.path`. It is nullable because a request that matched no
   route (a 404) has none. `path` carries the real requested path,
   prefix included.

`at` is timezone-aware UTC, set in Python rather than by a server default
so the value is identical on SQLite and Postgres. SQLite does not
round-trip tzinfo (see `deps.py`), so a value read back there is naive and
must be treated as UTC.
"""
import datetime

import sqlalchemy as sa
from sqlalchemy import DateTime, ForeignKey, Integer, String, Text
from sqlalchemy.orm import Mapped, mapped_column

from ..database import Base


class AuditLogEntry(Base):
    __tablename__ = "audit_log"

    id: Mapped[int] = mapped_column(primary_key=True)
    at: Mapped[datetime.datetime] = mapped_column(
        DateTime(timezone=True),
        nullable=False,
        index=True,
        default=lambda: datetime.datetime.now(datetime.timezone.utc),
    )

    # Identity: frozen snapshots, see module docstring.
    user_id: Mapped[int | None] = mapped_column(
        ForeignKey("users.id"), nullable=True, index=True
    )
    user_email: Mapped[str | None] = mapped_column(String, nullable=True)
    user_access_level: Mapped[str | None] = mapped_column(String, nullable=True)

    method: Mapped[str] = mapped_column(String(10), nullable=False)
    # Templated and router-local, e.g. "/rota/{rota_id}/sessions/{session_id}".
    route: Mapped[str | None] = mapped_column(String, nullable=True)
    # Deliberately unindexed: the only filter against it is a
    # leading-wildcard LIKE ("everything that touched /rota/12/"), which no
    # B-tree index can serve, so an index would cost a write per audited
    # request and serve no read.
    path: Mapped[str] = mapped_column(String, nullable=False)
    # Display only; the ASGI scope reports these values as strings.
    path_params: Mapped[dict | None] = mapped_column(sa.JSON, nullable=True)
    # Redacted JSON body, or an {"_audit": ...} marker for a body that was
    # too large, unparseable, or not JSON at all.
    request_body: Mapped[dict | None] = mapped_column(sa.JSON, nullable=True)

    status_code: Mapped[int] = mapped_column(Integer, nullable=False)
    # HTTPException.detail, a rendered validation error, or an exception repr.
    outcome_detail: Mapped[str | None] = mapped_column(Text, nullable=True)
    duration_ms: Mapped[int | None] = mapped_column(Integer, nullable=True)
    # First X-Forwarded-For entry when present, else the peer address.
    client_ip: Mapped[str | None] = mapped_column(String, nullable=True)

    def __repr__(self) -> str:  # pragma: no cover
        return f"<AuditLogEntry {self.method} {self.path} -> {self.status_code}>"
