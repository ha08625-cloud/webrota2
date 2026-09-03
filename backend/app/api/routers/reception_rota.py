"""Reception day rota router: generation, editing, and coverage validation
(reception rota, Task 4).

The day grid is a straight copy-then-edit, not a generation pipeline: POST
"" copies the weekday's master template rows onto a date (active staff
only), and everything after that is direct CRUD on the resulting
ReceptionRotaSession rows. There is no draft/commit lifecycle, no engine,
and no phases -- see ReceptionRota's docstring for why a bare header is
enough to distinguish "never generated" from "generated, then emptied".

Regenerating over an edited day is refused (409) rather than silently
overwritten -- DELETE /{id} then POST "" again is the only path back to a
fresh copy. The frontend puts a confirm dialog on that
delete-then-generate sequence; the server enforces no part of the confirm
itself.

Every mutating endpoint except the two 204 deletes returns
{session, issues}, recomputing coverage in the same transaction as the
write -- see compute_coverage_issues below -- so the grid never needs a
second request to learn whether an edit closed or opened a shortfall.
"""
from __future__ import annotations

import datetime

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.orm import Session

from ...engine.week_map import DAY_ORDER
from ...models import (
    ReceptionLeaveEntry,
    ReceptionMasterSession,
    ReceptionRota,
    ReceptionRotaSession,
    ReceptionStaff,
)
from ...models.enums import Day, ReceptionRole
from ...models.reception import (
    min_phones_for_hour,
    RECEPTION_HOURS,
    format_hour,
    format_hour_range,
)
from ...reception_counters import assignment_counter_window, compute_role_counters
from ...reception_front_desk import (
    FRONT_DESK_END_HOUR,
    FRONT_DESK_HOURS,
    select_front_desk_blocks,
)
from ..deps import get_current_user, get_db
from ..schemas import (
    ReceptionRotaGenerateIn,
    ReceptionRotaOut,
    ReceptionRotaSessionIn,
    ReceptionRotaSessionOut,
    ReceptionRotaSessionPatchIn,
    ReceptionSessionWriteOut,
    ValidationIssueOut,
)

router = APIRouter(prefix="/reception/rota", tags=["reception"])

_DAY_BY_WEEKDAY: dict[int, Day] = {weekday: day for day, weekday in DAY_ORDER.items()}


def _session_out(session: ReceptionRotaSession, staff: ReceptionStaff) -> ReceptionRotaSessionOut:
    return ReceptionRotaSessionOut(
        session_id=session.id,
        staff_id=session.staff_id,
        staff_code=staff.code,
        hour=session.hour,
        role=session.role,
        note=session.note,
    )


def _get_rota_or_404(db: Session, rota_id: int) -> ReceptionRota:
    rota = db.get(ReceptionRota, rota_id)
    if rota is None:
        raise HTTPException(status_code=404, detail=f"Rota {rota_id} not found")
    return rota


def _get_session_or_404(
    db: Session, rota_id: int, session_id: int
) -> ReceptionRotaSession:
    session = db.get(ReceptionRotaSession, session_id)
    if session is None or session.rota_id != rota_id:
        raise HTTPException(
            status_code=404,
            detail=f"Session {session_id} not found in rota {rota_id}",
        )
    return session


def _staff_on_leave(db: Session, date: datetime.date) -> set[int]:
    """Staff ids with a whole-day ReceptionLeaveEntry for `date`."""
    return set(
        db.execute(
            select(ReceptionLeaveEntry.staff_id).where(
                ReceptionLeaveEntry.date == date
            )
        ).scalars()
    )


def compute_coverage_issues(db: Session, rota: ReceptionRota) -> list[ValidationIssueOut]:
    """One issue per hour where the rota's phones headcount falls short of
    min_phones_for_hour -- which varies by hour of day (no cover needed
    before the lines open at 8:00, one person from 17:00, two in between)
    but not by weekday; there is no coverage-rules table and no UI to edit
    it. Counts come off
    `rota.sessions` (already loaded, not re-queried per hour). Always
    severity="warning" -- nothing in this feature blocks.

    Staff on leave for the rota's date are excluded from the headcount,
    which is the whole of what reception leave does. Their session rows are untouched and still
    returned by every read -- ReceptionRotaOut.staff_on_leave carries the
    same ids so the grid can dim them, since a warning counting fewer
    staff than the grid visibly shows would otherwise read as a bug.

    Also emits one `front_desk_gap` per *contiguous* uncovered range in
    FRONT_DESK_HOURS (8:00am-6:00pm) -- per-range, not per-hour, since up to
    twenty per-hour warnings stacked on top of the phones ones would swamp
    the panel and "08:00-13:00: no front desk cover" says the same thing
    once. Leave is excluded the same way it is for phones: a desk assigned
    to someone later marked off is not covered. Note this fires on every day
    generated before front desk assignment existed, since none of them have
    a front_desk role anywhere."""
    day = _DAY_BY_WEEKDAY[rota.date.weekday()]
    on_leave = _staff_on_leave(db, rota.date)

    counts: dict[float, int] = {}
    for session in rota.sessions:
        if session.role == ReceptionRole.PHONES and session.staff_id not in on_leave:
            counts[session.hour] = counts.get(session.hour, 0) + 1

    issues: list[ValidationIssueOut] = []
    for hour in RECEPTION_HOURS:
        count = counts.get(hour, 0)
        required = min_phones_for_hour(hour)
        if count < required:
            issues.append(ValidationIssueOut(
                severity="warning",
                phase="coverage",
                check="phones_shortfall",
                message=(
                    f"{format_hour(hour)}: {count} "
                    f"staff on phones, {required} required"
                ),
                day=day,
            ))

    covered = {
        session.hour
        for session in rota.sessions
        if session.role == ReceptionRole.FRONT_DESK and session.staff_id not in on_leave
    }

    def _gap(start: float, end: float) -> ValidationIssueOut:
        return ValidationIssueOut(
            severity="warning",
            phase="coverage",
            check="front_desk_gap",
            message=f"{format_hour_range(start, end)}: no front desk cover",
            day=day,
        )

    gap_start: float | None = None
    for hour in FRONT_DESK_HOURS:
        if hour not in covered:
            if gap_start is None:
                gap_start = hour
        elif gap_start is not None:
            issues.append(_gap(gap_start, hour))
            gap_start = None
    if gap_start is not None:
        issues.append(_gap(gap_start, FRONT_DESK_END_HOUR))
    return issues


def _rota_out(db: Session, rota: ReceptionRota) -> ReceptionRotaOut:
    rows = db.execute(
        select(ReceptionRotaSession, ReceptionStaff)
        .join(ReceptionStaff, ReceptionRotaSession.staff_id == ReceptionStaff.id)
        .where(ReceptionRotaSession.rota_id == rota.id)
        .order_by(ReceptionRotaSession.hour, ReceptionStaff.code)
    ).all()
    return ReceptionRotaOut(
        rota_id=rota.id,
        date=rota.date,
        created_at=rota.created_at,
        sessions=[_session_out(session, staff) for session, staff in rows],
        issues=compute_coverage_issues(db, rota),
        staff_on_leave=sorted(_staff_on_leave(db, rota.date)),
    )


@router.post("", response_model=ReceptionRotaOut, status_code=201)
def generate_rota(
    payload: ReceptionRotaGenerateIn,
    db: Session = Depends(get_db),
    user: dict = Depends(get_current_user),
) -> ReceptionRotaOut:
    """Copy the weekday's master template onto `date`, active staff only.
    Weekend dates are rejected by ReceptionRotaGenerateIn's validator
    (422) before this runs. An existing header for the date is a 409
    naming it -- regenerating never silently overwrites hand-edited rows;
    DELETE the existing rota first."""
    existing = db.execute(
        select(ReceptionRota).where(ReceptionRota.date == payload.date)
    ).scalars().first()
    if existing is not None:
        raise HTTPException(
            status_code=409,
            detail=(
                f"Rota {existing.id} already exists for {payload.date}; "
                "delete it first to regenerate"
            ),
        )

    day = _DAY_BY_WEEKDAY[payload.date.weekday()]
    template_rows = db.execute(
        select(ReceptionMasterSession)
        .join(ReceptionStaff, ReceptionMasterSession.staff_id == ReceptionStaff.id)
        .where(
            ReceptionMasterSession.day == day,
            ReceptionStaff.active.is_(True),
        )
    ).scalars().all()

    rota = ReceptionRota(date=payload.date)
    for row in template_rows:
        rota.sessions.append(ReceptionRotaSession(
            staff_id=row.staff_id, hour=row.hour, role=row.role, note=row.note,
        ))
    db.add(rota)
    db.flush()
    out = _rota_out(db, rota)
    db.commit()
    return out


@router.get("", response_model=ReceptionRotaOut)
def get_rota_by_date(
    date: datetime.date,
    db: Session = Depends(get_db),
    user: dict = Depends(get_current_user),
) -> ReceptionRotaOut:
    """How the day page decides between offering "Generate" (404) and
    "you are editing an existing day" (200)."""
    rota = db.execute(
        select(ReceptionRota).where(ReceptionRota.date == date)
    ).scalars().first()
    if rota is None:
        raise HTTPException(status_code=404, detail=f"No rota for {date}")
    return _rota_out(db, rota)


@router.get("/{rota_id}", response_model=ReceptionRotaOut)
def get_rota(
    rota_id: int,
    db: Session = Depends(get_db),
    user: dict = Depends(get_current_user),
) -> ReceptionRotaOut:
    rota = _get_rota_or_404(db, rota_id)
    return _rota_out(db, rota)


@router.post("/{rota_id}/front-desk", response_model=ReceptionRotaOut)
def assign_front_desk(
    rota_id: int,
    db: Session = Depends(get_db),
    user: dict = Depends(get_current_user),
) -> ReceptionRotaOut:
    """Choose who mans the front desk on this day and write it onto the
    existing session rows. No request body; returns the whole day with freshly
    recomputed issues, since a successful assignment rewrites many rows at once
    and the page should simply take the new state.

    A separate endpoint rather than a step inside POST "" (D7): generation
    stays a pure template copy with its 409 semantics intact, and assignment
    can be re-run without the delete-then-regenerate dance.

    404 on an unknown rota and no other error status. A day with no legal
    assignment is a 200 whose issues carry `front_desk_gap` warnings -- the
    documented outcome, not an error, and the same convention as everything
    else in reception, where nothing blocks.
    """
    rota = _get_rota_or_404(db, rota_id)

    # 1. Reset. Only rows this generator wrote (displaced_role IS NOT NULL --
    #    the invariant on ReceptionRotaSession) are touched, so a front_desk
    #    role tagged by hand, or one a later PATCH took ownership of, survives
    #    a re-run untouched. Reset-then-assign is what makes re-running
    #    idempotent.
    for session in rota.sessions:
        if session.displaced_role is not None:
            session.role = session.displaced_role
            session.displaced_role = None
    # 2. Flush before reading counters: compute_role_counters queries the
    #    sessions table, and this day is inside its own window, so without the
    #    flush the day's previous front-desk slots would count toward the
    #    fairness input for the assignment replacing them.
    db.flush()
    counters = compute_role_counters(db, *assignment_counter_window(rota.date))

    # 3. Choose. Performs no writes and returns [] when nothing legal exists.
    blocks = select_front_desk_blocks(rota, _staff_on_leave(db, rota.date), counters)

    # 4. Apply. displaced_role is set even when the previous role was already
    #    front_desk -- a no-op restore later, but it keeps D4's invariant total.
    by_slot = {
        (session.staff_id, session.hour): session for session in rota.sessions
    }
    for block in blocks:
        for hour in block.slot_hours:
            session = by_slot[(block.staff_id, hour)]
            session.displaced_role = session.role
            session.role = ReceptionRole.FRONT_DESK
    db.flush()

    out = _rota_out(db, rota)
    db.commit()
    return out


@router.post(
    "/{rota_id}/sessions", response_model=ReceptionSessionWriteOut, status_code=201
)
def create_session(
    rota_id: int,
    payload: ReceptionRotaSessionIn,
    db: Session = Depends(get_db),
    user: dict = Depends(get_current_user),
) -> ReceptionSessionWriteOut:
    """Add a staff member to an hour. 409 on a duplicate
    (rota_id, staff_id, hour), 404 on unknown staff."""
    rota = _get_rota_or_404(db, rota_id)
    staff = db.get(ReceptionStaff, payload.staff_id)
    if staff is None:
        raise HTTPException(
            status_code=404, detail=f"Reception staff {payload.staff_id} not found"
        )

    existing = db.execute(
        select(ReceptionRotaSession).where(
            ReceptionRotaSession.rota_id == rota_id,
            ReceptionRotaSession.staff_id == payload.staff_id,
            ReceptionRotaSession.hour == payload.hour,
        )
    ).scalars().first()
    if existing is not None:
        raise HTTPException(
            status_code=409,
            detail=(
                f"Staff {payload.staff_id} already has a session at hour "
                f"{payload.hour} in rota {rota_id}"
            ),
        )

    session = ReceptionRotaSession(
        rota_id=rota_id,
        staff_id=payload.staff_id,
        hour=payload.hour,
        role=payload.role,
        note=payload.note,
    )
    db.add(session)
    db.flush()
    issues = compute_coverage_issues(db, rota)
    db.commit()
    db.refresh(session)
    return ReceptionSessionWriteOut(session=_session_out(session, staff), issues=issues)


@router.patch(
    "/{rota_id}/sessions/{session_id}", response_model=ReceptionSessionWriteOut
)
def patch_session(
    rota_id: int,
    session_id: int,
    payload: ReceptionRotaSessionPatchIn,
    db: Session = Depends(get_db),
    user: dict = Depends(get_current_user),
) -> ReceptionSessionWriteOut:
    """Verbatim (role, note) pair setter, same contract as the master
    template's PATCH.

    Also clears `displaced_role`: a manual edit overrides whatever the
    front-desk assigner did to this slot, so a later reset must not restore a
    role the day no longer has. Clearing it unconditionally is right even when
    the user is *setting* `front_desk` by hand -- that tag is theirs, not the
    generator's, and the generator must leave it alone.
    """
    rota = _get_rota_or_404(db, rota_id)
    session = _get_session_or_404(db, rota_id, session_id)
    session.role = payload.role
    session.note = payload.note
    session.displaced_role = None
    db.flush()
    issues = compute_coverage_issues(db, rota)
    db.commit()
    db.refresh(session)
    return ReceptionSessionWriteOut(
        session=_session_out(session, session.staff), issues=issues
    )


@router.delete("/{rota_id}/sessions/{session_id}", status_code=204)
def delete_session(
    rota_id: int,
    session_id: int,
    db: Session = Depends(get_db),
    user: dict = Depends(get_current_user),
) -> None:
    """Remove a staff member from an hour -- still the per-slot absence
    mechanism, and the only one with half-hour precision: reception leave
    is whole-day, so "off from 2pm" is expressed here (or by tagging the
    slots `not_working`), not on the leave page. Coverage counts anyone
    with a remaining `phones` row unless they are on leave for the whole
    date. 204 with no body; the frontend refetches the day rather than
    splicing the response, since issues need recomputing too
    and this is an infrequent action."""
    _get_rota_or_404(db, rota_id)
    session = _get_session_or_404(db, rota_id, session_id)
    db.delete(session)
    db.commit()


@router.delete("/{rota_id}", status_code=204)
def delete_rota(
    rota_id: int,
    db: Session = Depends(get_db),
    user: dict = Depends(get_current_user),
) -> None:
    """Delete the whole day; sessions cascade (ORM
    cascade="all, delete-orphan" on ReceptionRota.sessions). Backs the
    UI's regenerate-behind-a-confirm -- there is no force/regenerate flag,
    just delete-then-POST, and the confirm dialog is where the user is
    told edits will be lost."""
    rota = _get_rota_or_404(db, rota_id)
    db.delete(rota)
    db.commit()
