"""Audit log read schemas.

`AuditLogEntryOut` mirrors the `AuditLogEntry` model column for column --
there is no write API for this table, so there is no matching `In` schema
and no field here is optional-because-patchable. `path_params` and
`request_body` come straight out of the model's JSON columns, so they are
typed as free-form dicts: `path_params` values are always strings (the ASGI
scope reports them that way, before FastAPI coerces to int at the
endpoint), and `request_body` is either the redacted request JSON or an
`{"_audit": ...}` marker.

`summary` and `outcome` are the two fields with no column behind them:
they are computed at read time from `(method, route, path_params)` and
`status_code` by `app/api/audit_descriptions.py`, so the audit page can
lead with "Committed rota 12 - Done" instead of
"POST /api/v1/rota/12/commit - 200". They are derived rather than stored
because the wording is presentation, not history: improving a sentence
should improve every historical row, not just the ones written after the
deploy.

`AuditLogListOut` wraps the page with the total count of rows matching the
filters, not the page -- the frontend needs it to render "x-y of total" and
to know whether a next page exists.
"""
from __future__ import annotations

import datetime

from pydantic import BaseModel, computed_field

# Aliased: `outcome` is also the name of the computed field below,
# and the shadowing reads as a bug even though method bodies resolve
# the module global rather than the class attribute.
from ..audit_descriptions import describe, outcome as describe_outcome


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

    # Derived, not stored -- see the module docstring. `computed_field`
    # rather than something the router assembles: it makes the pair
    # impossible to forget at a call site, and there is only ever one
    # reader of this table anyway.
    @computed_field
    @property
    def summary(self) -> str:
        return describe(self.method, self.route, self.path_params)

    @computed_field
    @property
    def outcome(self) -> str:
        return describe_outcome(self.status_code)


class AuditLogListOut(BaseModel):
    items: list[AuditLogEntryOut]
    total: int
