"""Audit log read schemas.

`AuditLogEntryOut` mirrors the `AuditLogEntry` model column for column --
there is no write API for this table, so there is no matching `In` schema
and no field here is optional-because-patchable. `path_params` and
`request_body` come straight out of the model's JSON columns, so they are
typed as free-form dicts: `path_params` values are always strings (the ASGI
scope reports them that way, before FastAPI coerces to int at the
endpoint), and `request_body` is either the redacted request JSON or an
`{"_audit": ...}` marker.

`AuditLogListOut` wraps the page with the total count of rows matching the
filters, not the page -- the frontend needs it to render "x-y of total" and
to know whether a next page exists.
"""
from __future__ import annotations

import datetime

from pydantic import BaseModel


class AuditLogEntryOut(BaseModel):
    id: int
    at: datetime.datetime
    user_id: int | None = None
    user_email: str | None = None
    user_access_level: str | None = None
    method: str
    # Templated and router-local (no /api/v1 prefix); null when nothing matched.
    route: str | None = None
    path: str
    path_params: dict | None = None
    request_body: dict | None = None
    status_code: int
    outcome_detail: str | None = None
    duration_ms: int | None = None
    client_ip: str | None = None

    model_config = {"from_attributes": True}


class AuditLogListOut(BaseModel):
    items: list[AuditLogEntryOut]
    total: int
