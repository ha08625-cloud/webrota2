"""Leave entitlement router (leave entitlement and balances plan).

Three endpoints under `/leave/entitlement`:

- `GET  /leave/entitlement?year=` -- every doctor with an entitlement, with
  their usage and balance for that leave year.
- `PUT  /leave/entitlement/{doctor_id}?year=` -- upsert the stored deviations
  (override, carry-over, adjustment, notes) for one doctor and year.
- `DELETE /leave/entitlement/{doctor_id}?year=` -- drop the stored row, so
  the doctor reverts to the rule figure.

A separate module from `leave.py` rather than four more endpoints on it: that
router is already at the size where finding anything is a scroll, and this is
a self-contained read model over it. The `/leave` prefix is kept because this
is still a per-doctor leave question, and `leave.py` has no `GET /leave/{id}`
for `/leave/entitlement` to be shadowed by (only a `DELETE`), so there is no
route-ordering hazard in either direction.

Balances are computed at read time from the live master template and closure
tables -- see `app/leave_charging.py` for the cost of that. Nothing here
writes a usage figure anywhere.
"""
from __future__ import annotations

import datetime
from collections import defaultdict
from decimal import Decimal

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from ...leave_charging import summarise_leave_charging
from ...leave_entitlement import (
    LEAVE_WEEKS_BY_DOCTOR_TYPE,
    build_entitlement,
    quantise_sessions,
    template_sessions_per_week,
    year_bounds,
)
from ...master_template import load_week_one_template
from ...models import Doctor, LeaveEntitlement, LeaveEntry, PracticeClosure
from ..deps import get_current_user, get_db
from ..schemas import (
    LeaveEntitlementIn,
    LeaveEntitlementOut,
    LeaveEntitlementYearOut,
)
from ..schemas.leave import LeaveExemptionsOut
from ..schemas.leave_entitlement import MAX_LEAVE_YEAR, MIN_LEAVE_YEAR

router = APIRouter(prefix="/leave/entitlement", tags=["leave"])


def _resolve_year(year: int | None) -> int:
    """Default to the current calendar year, and bound a typo'd one.

    Defaulted server-side rather than required: the natural request is "this
    leave year" and the server's clock is the one that decides which that is.
    The resolved year is echoed on the response so a client never has to
    assume its own clock agreed.
    """
    resolved = year if year is not None else datetime.date.today().year
    if not MIN_LEAVE_YEAR <= resolved <= MAX_LEAVE_YEAR:
        raise HTTPException(
            status_code=422,
            detail=f"year must be between {MIN_LEAVE_YEAR} and {MAX_LEAVE_YEAR}",
        )
    return resolved


def _build_out(
    doctor: Doctor,
    year: int,
    stored: LeaveEntitlement | None,
    entries: list[LeaveEntry],
    template,
    closed,
) -> LeaveEntitlementOut:
    breakdown = build_entitlement(
        doctor_type=doctor.doctor_type,
        sessions_per_week=doctor.sessions_per_week,
        start_date=doctor.start_date,
        end_date=doctor.end_date,
        year=year,
        override_sessions=stored.entitlement_sessions if stored else None,
        carry_over_sessions=stored.carry_over_sessions if stored else Decimal("0.0"),
        adjustment_sessions=stored.adjustment_sessions if stored else Decimal("0.0"),
    )
    summary = summarise_leave_charging(entries, template, closed)
    template_sessions = template_sessions_per_week(doctor.id, template)
    return LeaveEntitlementOut(
        doctor_id=doctor.id,
        doctor_code=doctor.code,
        doctor_type=doctor.doctor_type,
        year=year,
        sessions_per_week=doctor.sessions_per_week,
        weeks=breakdown.weeks,
        full_year_sessions=breakdown.full_year_sessions,
        pro_rata_fraction=breakdown.pro_rata_fraction.quantize(Decimal("0.001")),
        rule_sessions=breakdown.rule_sessions,
        override_sessions=breakdown.override_sessions,
        carry_over_sessions=breakdown.carry_over_sessions,
        adjustment_sessions=breakdown.adjustment_sessions,
        entitlement_sessions=breakdown.total_sessions,
        used_sessions=summary.chargeable_sessions,
        booked_sessions=summary.total_entries,
        exempt_by_reason=LeaveExemptionsOut(
            closed=summary.exempt_by_reason["closed"],
            weekend=summary.exempt_by_reason["weekend"],
            no_template_row=summary.exempt_by_reason["no_template_row"],
            no_surgery=summary.exempt_by_reason["no_surgery"],
        ),
        remaining_sessions=(
            None
            if breakdown.total_sessions is None
            else quantise_sessions(
                breakdown.total_sessions - Decimal(summary.chargeable_sessions)
            )
        ),
        template_sessions_per_week=template_sessions,
        sessions_mismatch=(
            template_sessions > 0
            and Decimal(template_sessions) != Decimal(doctor.sessions_per_week)
        ),
        notes=stored.notes if stored else None,
    )


def _load_year_inputs(db: Session, year: int):
    """The three reads every balance needs, once for the whole practice."""
    jan, dec = year_bounds(year)
    entries = db.execute(
        select(LeaveEntry)
        .where(LeaveEntry.date >= jan)
        .where(LeaveEntry.date <= dec)
    ).scalars().all()
    entries_by_doctor: dict[int, list[LeaveEntry]] = defaultdict(list)
    for entry in entries:
        entries_by_doctor[entry.doctor_id].append(entry)

    template = load_week_one_template(db)
    closed = {
        (c.date, c.period)
        for c in db.execute(
            select(PracticeClosure)
            .where(PracticeClosure.date >= jan)
            .where(PracticeClosure.date <= dec)
        ).scalars()
    }
    return entries_by_doctor, template, closed


def _get_stored(db: Session, doctor_id: int, year: int) -> LeaveEntitlement | None:
    return db.execute(
        select(LeaveEntitlement)
        .where(LeaveEntitlement.doctor_id == doctor_id)
        .where(LeaveEntitlement.year == year)
    ).scalars().first()


@router.get("", response_model=LeaveEntitlementYearOut)
def list_entitlements(
    year: int | None = Query(default=None),
    db: Session = Depends(get_db),
    user: dict = Depends(get_current_user),
) -> LeaveEntitlementYearOut:
    """Balances for every doctor the practice tracks leave for.

    Doctor types with no entitlement (AHP, locum) are omitted entirely
    rather than listed with nulls -- an AHP's leave is assigned by a third
    party and is not the practice's to reconcile, so a row for one is noise
    on a screen whose whole job is spotting a doctor who is over or under.

    Inactive doctors are included only when they booked leave in the year in
    question. A doctor who left is still owed an accurate figure for the year
    they left in, and hiding it would make a year's totals stop adding up as
    soon as someone was deactivated; a doctor who left years ago has no leave
    in this year and drops out on their own.
    """
    resolved = _resolve_year(year)
    jan, dec = year_bounds(resolved)
    entries_by_doctor, template, closed = _load_year_inputs(db, resolved)

    doctors = db.execute(select(Doctor).order_by(Doctor.id)).scalars().all()
    stored_rows = {
        row.doctor_id: row
        for row in db.execute(
            select(LeaveEntitlement).where(LeaveEntitlement.year == resolved)
        ).scalars()
    }

    out: list[LeaveEntitlementOut] = []
    for doctor in doctors:
        if doctor.doctor_type not in LEAVE_WEEKS_BY_DOCTOR_TYPE:
            continue
        entries = entries_by_doctor.get(doctor.id, [])
        if not doctor.active and not entries:
            continue
        out.append(
            _build_out(
                doctor, resolved, stored_rows.get(doctor.id), entries, template, closed
            )
        )

    return LeaveEntitlementYearOut(
        year=resolved, from_date=jan, to_date=dec, doctors=out
    )


@router.get("/{doctor_id}", response_model=LeaveEntitlementOut)
def get_entitlement(
    doctor_id: int,
    year: int | None = Query(default=None),
    db: Session = Depends(get_db),
    user: dict = Depends(get_current_user),
) -> LeaveEntitlementOut:
    """One doctor's balance, including doctor types with no entitlement.

    Unlike the list, this does not filter by type: asked about a specific
    AHP, the honest answer is the row with null entitlement fields, not a
    404 that reads as "no such doctor".
    """
    resolved = _resolve_year(year)
    doctor = db.get(Doctor, doctor_id)
    if doctor is None:
        raise HTTPException(status_code=404, detail=f"Doctor {doctor_id} not found")

    entries_by_doctor, template, closed = _load_year_inputs(db, resolved)
    return _build_out(
        doctor,
        resolved,
        _get_stored(db, doctor_id, resolved),
        entries_by_doctor.get(doctor_id, []),
        template,
        closed,
    )


@router.put("/{doctor_id}", response_model=LeaveEntitlementOut)
def upsert_entitlement(
    doctor_id: int,
    payload: LeaveEntitlementIn,
    year: int | None = Query(default=None),
    db: Session = Depends(get_db),
    user: dict = Depends(get_current_user),
) -> LeaveEntitlementOut:
    """Store one doctor's deviations from the rules for one year.

    A full replace (PUT, not PATCH): the body is four fields that are read
    together on one screen, and a partial update of "carry-over only" that
    silently kept a stale override would be the surprising behaviour.
    Omitted fields therefore reset to their defaults -- null override, zero
    carry-over, zero adjustment, no notes.

    422 for a doctor type with no entitlement. An override on an AHP or a
    locum has no meaning and would sit in the table looking authoritative,
    so it is refused at the boundary rather than ignored downstream.
    """
    resolved = _resolve_year(year)
    doctor = db.get(Doctor, doctor_id)
    if doctor is None:
        raise HTTPException(status_code=404, detail=f"Doctor {doctor_id} not found")
    if doctor.doctor_type not in LEAVE_WEEKS_BY_DOCTOR_TYPE:
        raise HTTPException(
            status_code=422,
            detail=(
                f"{doctor.doctor_type.value} doctors have no leave entitlement, "
                "so none can be recorded"
            ),
        )

    stored = _get_stored(db, doctor_id, resolved)
    if stored is None:
        stored = LeaveEntitlement(doctor_id=doctor_id, year=resolved)
        db.add(stored)
    stored.entitlement_sessions = payload.entitlement_sessions
    stored.carry_over_sessions = payload.carry_over_sessions
    stored.adjustment_sessions = payload.adjustment_sessions
    stored.notes = payload.notes

    try:
        db.commit()
    except IntegrityError as exc:
        db.rollback()
        raise HTTPException(
            status_code=409,
            detail="Entitlement for this doctor and year was created concurrently; please retry.",
        ) from exc
    db.refresh(stored)

    entries_by_doctor, template, closed = _load_year_inputs(db, resolved)
    return _build_out(
        doctor,
        resolved,
        stored,
        entries_by_doctor.get(doctor_id, []),
        template,
        closed,
    )


@router.delete("/{doctor_id}", status_code=204)
def delete_entitlement(
    doctor_id: int,
    year: int | None = Query(default=None),
    db: Session = Depends(get_db),
    user: dict = Depends(get_current_user),
) -> None:
    """Drop the stored row, reverting the doctor to the rule figure.

    404 when there is no row: this deletes a *record*, and reporting success
    for a row that was never there would hide a wrong year in the caller's
    request.
    """
    resolved = _resolve_year(year)
    stored = _get_stored(db, doctor_id, resolved)
    if stored is None:
        raise HTTPException(
            status_code=404,
            detail=f"No stored entitlement for doctor {doctor_id} in {resolved}",
        )
    db.delete(stored)
    db.commit()
