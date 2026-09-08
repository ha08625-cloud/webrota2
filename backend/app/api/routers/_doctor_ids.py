"""Shared doctor-id existence/active check for the two note routers.

Not a router -- the leading underscore marks it as internal to the
routers package (same convention as _uploads.py), so nothing here is
mistaken for a module with a `router` attribute to register in main.py.

It lives here rather than as a Pydantic validator for the reason
duty.py's closed-date check is a router check: a stateless validator
cannot see the doctors table. recurring_notes.py (definitions) and
staging.py (per-run instances) apply the identical rule to the identical
field, so the message wording is shared rather than copied.
"""
from __future__ import annotations

from fastapi import HTTPException
from sqlalchemy import select
from sqlalchemy.orm import Session

from ...models import Doctor


def validate_doctor_ids(db: Session, doctor_ids: list[int]) -> None:
    """Every id must exist and be active, else 422 naming the offending ids."""
    rows = db.execute(
        select(Doctor.id, Doctor.active).where(Doctor.id.in_(doctor_ids))
    ).all()
    found = {row.id: row.active for row in rows}
    missing = sorted(set(doctor_ids) - found.keys())
    inactive = sorted(i for i in doctor_ids if i in found and not found[i])
    if missing or inactive:
        parts = []
        if missing:
            parts.append(f"doctor id(s) {missing} do not exist")
        if inactive:
            parts.append(f"doctor id(s) {inactive} are not active")
        raise HTTPException(status_code=422, detail="; ".join(parts))
