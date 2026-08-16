"""Audit log read API: one manager-only, filtered, paginated list endpoint.

There is no write API for this table at all -- no POST, PATCH or DELETE
exists here or anywhere else, and nothing prunes it. The only writer is the
audit middleware (see app/api/audit.py), which appends a row per non-GET
request in its own transaction after the endpoint has committed.

The whole router is manager-only: `require_manager` hangs off the
`APIRouter` itself rather than each endpoint, because this gates reads too
and there is no per-endpoint exception to carve out (unlike routers/users.py,
where PATCH /users/me has to stay open to every tier). It is still
registered through main.py's normal gated loop rather than `_UNGATED`, so
that if a non-GET endpoint is ever added here it inherits the global write
gate as well. That costs no extra query: `require_write_access` and
`require_manager` both depend on `get_current_user`, which FastAPI caches
per request.

Filtering `path` is a substring match, which is the query a human debugging
an incident actually wants -- "show me everything that touched /rota/12/".
Two things about it are worth knowing at the call site:

- It has no word boundaries, so `/rota/12` matches `/rota/120` too;
  `/rota/12/` narrows it to sub-resources of rota 12.
- The value goes through `.contains(..., autoescape=True)`, so a `%` or `_`
  typed into a filter box is matched literally rather than silently
  becoming a wildcard.

There is no index behind that filter and it is a sequential scan by design
-- a leading-wildcard LIKE cannot use a B-tree index, and the alternative
(pg_trgm) would break the SQLite parity the test suite runs on. The same
applies to `total`: it is an exact `COUNT(*)` over the filtered set, which
is the first thing that will degrade as the table grows. At this scale that
is a long way off, and the cheap fix when it arrives is to stop returning an
exact total rather than to start deleting rows.
"""
from __future__ import annotations

import datetime

from fastapi import APIRouter, Depends, Query
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from ...models import AuditLogEntry
from ..deps import get_db, require_manager
from ..schemas import AuditLogListOut

router = APIRouter(
    prefix="/audit",
    tags=["audit"],
    dependencies=[Depends(require_manager)],
)


@router.get("", response_model=AuditLogListOut)
def list_audit_log(
    db: Session = Depends(get_db),
    limit: int = Query(default=50, ge=1, le=200),
    offset: int = Query(default=0, ge=0),
    user_id: int | None = Query(default=None),
    path_contains: str | None = Query(default=None),
    method: str | None = Query(default=None),
    status_min: int | None = Query(default=None),
    status_max: int | None = Query(default=None),
    since: datetime.datetime | None = Query(default=None),
    until: datetime.datetime | None = Query(default=None),
) -> AuditLogListOut:
    """One page of audit rows, newest first, plus the filtered total.

    `status_min`/`status_max` and `since`/`until` are inclusive ranges.
    Timestamps are UTC: SQLite does not round-trip tzinfo, so `at` is
    compared and returned as a UTC wall-clock value regardless of what
    offset a caller sends.
    """
    filters = []
    if user_id is not None:
        filters.append(AuditLogEntry.user_id == user_id)
    if path_contains:
        # autoescape is required: without it a % or _ typed by the user
        # becomes a wildcard and silently changes the query.
        filters.append(AuditLogEntry.path.contains(path_contains, autoescape=True))
    if method:
        filters.append(AuditLogEntry.method == method.upper())
    if status_min is not None:
        filters.append(AuditLogEntry.status_code >= status_min)
    if status_max is not None:
        filters.append(AuditLogEntry.status_code <= status_max)
    if since is not None:
        filters.append(AuditLogEntry.at >= since)
    if until is not None:
        filters.append(AuditLogEntry.at <= until)

    # One filter list applied to both queries, so `total` always describes
    # the same set the page is drawn from.
    total = db.execute(
        select(func.count()).select_from(AuditLogEntry).where(*filters)
    ).scalar_one()

    # The id tiebreak is not decorative: `at` values collide under a burst,
    # and without a total ordering offset paging can repeat or skip rows.
    rows = db.execute(
        select(AuditLogEntry)
        .where(*filters)
        .order_by(AuditLogEntry.at.desc(), AuditLogEntry.id.desc())
        .limit(limit)
        .offset(offset)
    ).scalars().all()

    return AuditLogListOut(items=rows, total=total)
