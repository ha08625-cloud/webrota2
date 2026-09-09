"""Reception role counter router: one read-only endpoint over the shared
compute module.

A separate module from reception_rota.py purely so the router boundary
matches the URL prefix -- that one is prefixed /reception/rota and this is
/reception/counters, and two APIRouters in one file would be the only
reason to merge them.

There is deliberately no arithmetic here. The window rule and the
aggregation both live in app/reception_counters.py, because the
front-desk assigner (app/reception_front_desk.py, via
`POST /reception/rota/{id}/assign-roles`) calls them directly and must not
be able to disagree with this endpoint about what a counter means. This router
resolves the window, calls the function, and maps dataclasses onto
schemas; anything more that appears here belongs in that module instead.

No access-level gate beyond authentication: reception endpoints have none
today. The global write
gate in main.py is inert here anyway -- GET only.
"""
from __future__ import annotations

import datetime

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from ...models import User
from ...reception_counters import compute_role_counters, default_counter_window
from ..deps import get_current_user, get_db
from ..schemas import ReceptionCounterRowOut, ReceptionCountersOut

router = APIRouter(prefix="/reception/counters", tags=["reception"])


def _today() -> datetime.date:
    """Indirection so tests can pin "today" by monkeypatching this name.

    `default_counter_window` already takes today as a parameter for exactly
    this reason, but something has to supply it, and `datetime.date.today`
    itself cannot be patched (it lives on a C type). One module-level
    function is the smallest seam that keeps the default-window test
    deterministic instead of asserting against the wall clock.
    """
    return datetime.date.today()


@router.get("", response_model=ReceptionCountersOut)
def get_reception_counters(
    from_date: datetime.date | None = None,
    to_date: datetime.date | None = None,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
) -> ReceptionCountersOut:
    """Per-staff role slot counts, hours worked and days present over
    [from_date, to_date] inclusive.

    Either bound may be omitted and is then filled from the default window
    (the four complete preceding weeks plus the current week to date). The
    two are filled independently rather than as a pair, so
    `?from_date=2026-01-01` alone means "since new year, up to today"
    rather than silently discarding the caller's bound.

    The only validation is from_date <= to_date. A range covering dates
    with no generated rotas is a legitimate question and answers
    `days_counted: 0` rather than an error.
    """
    window_from, window_to = default_counter_window(_today())
    resolved_from = from_date if from_date is not None else window_from
    resolved_to = to_date if to_date is not None else window_to
    if resolved_from > resolved_to:
        raise HTTPException(
            status_code=422, detail="from_date must not be after to_date"
        )

    counters = compute_role_counters(db, resolved_from, resolved_to)
    return ReceptionCountersOut(
        from_date=counters.from_date,
        to_date=counters.to_date,
        days_counted=counters.days_counted,
        staff=[
            ReceptionCounterRowOut(
                staff_id=row.staff_id,
                staff_code=row.code,
                active=row.active,
                hours_worked=row.hours_worked,
                days_present=row.days_present,
                role_slots={role.value: slots for role, slots in row.role_slots.items()},
            )
            for row in counters.staff
        ],
    )
