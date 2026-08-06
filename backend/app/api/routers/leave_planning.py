"""Leave planning router (annual leave planning, Task 3).

Two endpoints backing the month-at-a-time planning grid:

* `GET /leave-planning/coverage` -- a read-only clinical headcount per
  (date, period), so the admin can see what a planned absence does to
  cover before saving it.
* `POST /leave-planning/bulk` -- one transaction applying a batch of
  leave / extra-session / clear actions.

A new router rather than an extension of `/leave` (Design Decision 11):
`/leave` and `/extra-sessions` remain the ad-hoc, one-off path during the
year and are untouched by this file.

Two asymmetries this module inherits and must not paper over:

* Leave and extra sessions are not equivalent. Leave is read live by the
  engine on every run; an extra session is applied *once*, in the
  `POST /staging` copy loop, and is conditional on the template row being
  overridable (Design Decision 4). So the coverage calculation applies the
  same override table `routers/staging.py` does -- importing its
  `_OVERRIDABLE_TYPES` rather than redeclaring it -- instead of a flat +1.
* Adding leave releases draft rooms; clearing it does not restore them
  (Design Decision 10), matching both `/leave/bulk-delete` and the WFH
  behaviour.

Blocked (clinical rota, "Blocked" annual planner option) is a third,
independent cell state for things like a whole-day training session: the
doctor is unavailable for clinical cover, but this is deliberately **not**
leave -- it must not touch `leave_entries` or anything that reads it (the
generation engine, leave balances, `/leave`). It is stored in its own
`BlockedEntry` table and only ever written from this router. For the
coverage total it is treated exactly like leave (excluded from headcount,
checked before leave/extra precedence); for draft-room release it is also
treated like leave, since a blocked doctor is equally not going to be
there. Precedence across the three non-clear actions is leave > blocked >
extra_session -- a cell holds at most one of them in normal use (the grid
enforces this by emitting a `clear` before switching state), and this
router's skip reasons (`leave_exists` / `blocked_exists`) exist to keep a
stale-grid batch from silently producing two rows on one cell.
"""
from __future__ import annotations

import datetime

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from ...doctor_window import is_within_window
from ...master_template import DAY_BY_WEEKDAY, WEEKDAY_MAX, load_week_one_template
from ...models import (
    BlockedEntry,
    Doctor,
    ExtraSessionEntry,
    LeaveEntry,
    PracticeClosure,
)
from ...models.enums import DoctorType, MasterSessionType, Period
from ..deps import get_current_user, get_db
from ..schemas import (
    BlockedOut,
    CoverageSlotOut,
    ExtraSessionOut,
    PlanningBulkIn,
    PlanningBulkOut,
    PlanningSkippedOut,
)
from ..schemas.leave_planning import MAX_COVERAGE_RANGE_DAYS
from .leave import _release_draft_rooms
from .staging import _OVERRIDABLE_TYPES

router = APIRouter(prefix="/leave-planning", tags=["leave-planning"])

# The two template types that mean "this doctor is clinically working this
# slot" (Design Decision 3). NO_SURGERY / ADMIN_TIME / WFH / no template
# row all count as zero -- exactly the set `_OVERRIDABLE_TYPES` (plus
# absence) converts *into* REQUIRES_ROOM, so the two halves of the grid
# agree with each other by construction.
_COUNTED_TYPES = frozenset({
    MasterSessionType.REQUIRES_ROOM,
    MasterSessionType.PRE_ASSIGNED,
})

# Rows the planning grid renders and totals (Design Decision 2). Applied
# server-side here and client-side in the row build, so the on-screen
# total always equals the sum of the visible rows. Deliberately NOT
# applied to the bulk write endpoint below, which is a generic write path
# with no reason to refuse a Trainee.
_PLANNING_DOCTOR_TYPES = frozenset({DoctorType.PARTNER, DoctorType.SALARIED, DoctorType.LOCUM})


def _weekdays(start: datetime.date, end: datetime.date) -> list[datetime.date]:
    """Every Mon-Fri date in the inclusive range. Weekends are omitted from
    the coverage response entirely rather than returned as zero -- the grid
    has no weekend columns."""
    days: list[datetime.date] = []
    for offset in range((end - start).days + 1):
        day = start + datetime.timedelta(days=offset)
        if day.weekday() <= WEEKDAY_MAX:
            days.append(day)
    return days


def _slot_keys(
    db: Session,
    model,
    start: datetime.date,
    end: datetime.date,
) -> set[tuple[int, datetime.date, Period]]:
    """(doctor_id, date, period) keys for LeaveEntry or ExtraSessionEntry
    across a date range -- one query, not one per cell."""
    rows = db.execute(
        select(model).where(model.date >= start, model.date <= end)
    ).scalars().all()
    return {(r.doctor_id, r.date, r.period) for r in rows}


@router.get("/coverage", response_model=list[CoverageSlotOut])
def get_coverage(
    from_date: datetime.date,
    to_date: datetime.date,
    db: Session = Depends(get_db),
    user: dict = Depends(get_current_user),
) -> list[CoverageSlotOut]:
    """Clinical headcount per (date, period) across the weekday range.

    Read-only, and deliberately live: closures, leave, extra sessions and
    the employment window are all read from their current tables. This is
    forward planning, not the rendering of an existing rota, so there is no
    snapshot to prefer (Design Decision 5).
    """
    if from_date > to_date:
        raise HTTPException(
            status_code=422, detail="from_date must not be after to_date"
        )
    if (to_date - from_date).days > MAX_COVERAGE_RANGE_DAYS:
        raise HTTPException(
            status_code=422,
            detail=f"range must not exceed {MAX_COVERAGE_RANGE_DAYS} days",
        )

    dates = _weekdays(from_date, to_date)
    if not dates:
        return []

    doctors = [
        d
        for d in db.execute(
            select(Doctor).where(Doctor.active.is_(True)).order_by(Doctor.id)
        ).scalars()
        if d.doctor_type in _PLANNING_DOCTOR_TYPES
    ]
    template = load_week_one_template(db)
    leave = _slot_keys(db, LeaveEntry, from_date, to_date)
    extra = _slot_keys(db, ExtraSessionEntry, from_date, to_date)
    blocked = _slot_keys(db, BlockedEntry, from_date, to_date)
    closed = {
        (c.date, c.period)
        for c in db.execute(
            select(PracticeClosure).where(
                PracticeClosure.date >= from_date,
                PracticeClosure.date <= to_date,
            )
        ).scalars()
    }

    out: list[CoverageSlotOut] = []
    for day in dates:
        day_enum = DAY_BY_WEEKDAY[day.weekday()]
        for period in (Period.AM, Period.PM):
            if (day, period) in closed:
                # Phase 2 creates no slot on a closed (date, period), so the
                # headcount is zero rather than the template's -- a closed
                # cell is not an uncovered one.
                out.append(CoverageSlotOut(
                    date=day, period=period, headcount=0, is_closed=True,
                ))
                continue

            headcount = 0
            for doctor in doctors:
                slot = (doctor.id, day, period)
                if slot in leave or slot in blocked:
                    # Leave and blocked both mean "not covering" and skip
                    # the extra-session override entirely (extra sessions
                    # plan, Design Decision 6; blocked is treated the same
                    # way for coverage purposes only -- see module
                    # docstring).
                    continue
                if not is_within_window(doctor, day):
                    continue

                effective = template.get((doctor.id, day_enum, period))
                if slot in extra and (
                    effective is None or effective in _OVERRIDABLE_TYPES
                ):
                    # The staging copy loop demotes an ADMIN_TIME row that
                    # holds a room to PRE_ASSIGNED rather than
                    # REQUIRES_ROOM; both count, so the headcount does not
                    # need to reproduce that branch.
                    effective = MasterSessionType.REQUIRES_ROOM
                if effective in _COUNTED_TYPES:
                    headcount += 1

            out.append(CoverageSlotOut(
                date=day, period=period, headcount=headcount, is_closed=False,
            ))
    return out


@router.get("/blocked", response_model=list[BlockedOut])
def list_blocked(
    doctor_id: int | None = None,
    from_date: datetime.date | None = None,
    to_date: datetime.date | None = None,
    db: Session = Depends(get_db),
    user: dict = Depends(get_current_user),
) -> list[BlockedEntry]:
    """All `BlockedEntry` rows, optionally filtered -- the read side the
    Annual Planner grid needs to render blocked cells and their notes,
    mirroring `GET /extra-sessions`'s shape. There is no ad-hoc write
    endpoint here; the only way to create or delete a `BlockedEntry` is
    `POST /leave-planning/bulk` below."""
    stmt = select(BlockedEntry).order_by(BlockedEntry.date, BlockedEntry.doctor_id)
    if doctor_id is not None:
        stmt = stmt.where(BlockedEntry.doctor_id == doctor_id)
    if from_date is not None:
        stmt = stmt.where(BlockedEntry.date >= from_date)
    if to_date is not None:
        stmt = stmt.where(BlockedEntry.date <= to_date)
    return db.execute(stmt).scalars().all()


@router.post("/bulk", response_model=PlanningBulkOut, status_code=200)
def apply_planning_bulk(
    payload: PlanningBulkIn,
    db: Session = Depends(get_db),
    user: dict = Depends(get_current_user),
) -> PlanningBulkOut:
    """Apply a batch of planning-grid edits in one transaction.

    Actions are applied in a fixed order -- **clears, then leave, then
    blocked, then extra sessions** (Design Decision 9) -- so a batch
    touching more than one side of a slot resolves deterministically along
    the leave > blocked > extra_session precedence (see module docstring).

    Nothing here 409s on a state that already matches: the grid sends the
    state it wants, so setting leave where leave already exists is a
    "duplicate" skip, not a failure -- unless the requested notes differ
    from what's stored, in which case the row's notes are updated in place
    and the action counts as applied. A pre-existing `ExtraSessionEntry`
    the batch's leave covers is *reported* in `superseded_extra_sessions`
    -- never deleted, never blocked -- exactly as `create_leave_bulk` does.

    Unlike the single-entry endpoints, an out-of-window action is a skip
    rather than a 422 (Design Decision 8): one stale cell must not fail a
    200-cell save.
    """
    if not payload.actions:
        return PlanningBulkOut(applied=0, skipped=[], superseded_extra_sessions=[])

    # One query for the whole batch, not one per action.
    doctor_ids = {a.doctor_id for a in payload.actions}
    doctors = {
        d.id: d
        for d in db.execute(
            select(Doctor).where(Doctor.id.in_(doctor_ids))
        ).scalars()
    }
    missing = sorted(doctor_ids - doctors.keys())
    if missing:
        raise HTTPException(
            status_code=404,
            detail=f"Doctor {missing[0]} not found",
        )

    # Weekday-only, mirroring `POST /extra-sessions`. The grid has no
    # weekend cells, so a weekend action can only be a client bug -- a 422
    # is more useful than a silent skip here, unlike the window case where
    # the data legitimately moves under a stale grid.
    for action in payload.actions:
        if action.date.weekday() > WEEKDAY_MAX:
            raise HTTPException(
                status_code=422,
                detail=(
                    f"{action.date.isoformat()} is a weekend; the planning "
                    "grid covers weekdays only"
                ),
            )

    span_start = min(a.date for a in payload.actions)
    span_end = max(a.date for a in payload.actions)
    leave_rows = {
        (r.doctor_id, r.date, r.period): r
        for r in db.execute(
            select(LeaveEntry).where(
                LeaveEntry.doctor_id.in_(doctor_ids),
                LeaveEntry.date >= span_start,
                LeaveEntry.date <= span_end,
            )
        ).scalars()
    }
    extra_rows = {
        (r.doctor_id, r.date, r.period): r
        for r in db.execute(
            select(ExtraSessionEntry).where(
                ExtraSessionEntry.doctor_id.in_(doctor_ids),
                ExtraSessionEntry.date >= span_start,
                ExtraSessionEntry.date <= span_end,
            )
        ).scalars()
    }
    blocked_rows = {
        (r.doctor_id, r.date, r.period): r
        for r in db.execute(
            select(BlockedEntry).where(
                BlockedEntry.doctor_id.in_(doctor_ids),
                BlockedEntry.date >= span_start,
                BlockedEntry.date <= span_end,
            )
        ).scalars()
    }

    applied = 0
    skipped: list[PlanningSkippedOut] = []

    def _skip(action, reason: str) -> None:
        skipped.append(PlanningSkippedOut(
            doctor_id=action.doctor_id,
            date=action.date,
            period=action.period,
            action=action.action,
            reason=reason,
        ))

    # --- 1. Clears -----------------------------------------------------
    # All three row types are keyed on the same (doctor_id, date, period)
    # triple, so a clear removes whichever of them exists with nothing to
    # disambiguate. Draft rooms are deliberately not restored (Design
    # Decision 10).
    for action in (a for a in payload.actions if a.action == "clear"):
        key = (action.doctor_id, action.date, action.period)
        removed = False
        for rows in (leave_rows, extra_rows, blocked_rows):
            row = rows.pop(key, None)
            if row is not None:
                db.delete(row)
                removed = True
        if removed:
            applied += 1
        else:
            _skip(action, "nothing_to_clear")

    # Flush the deletes before any insert below. SQLAlchemy's unit of work
    # emits a mapper's INSERTs before its DELETEs within one flush, so a
    # batch that clears a cell and then sets leave on it would otherwise
    # collide on uq_leave_slot and 409 -- a legal, if unusual, batch.
    db.flush()

    # --- 2. Leave ------------------------------------------------------
    # `candidates` collects every in-window leave action, duplicates
    # included, and the whole set goes to _release_draft_rooms: a
    # duplicate means the leave already existed, and releasing again is a
    # harmless no-op or a heal of stale room state. This is the deliberate
    # over-call documented in routers/leave.py -- do not narrow it to the
    # rows actually inserted.
    candidates: dict[int, list[tuple[datetime.date, Period]]] = {}
    leave_slots: set[tuple[int, datetime.date, Period]] = set()
    for action in (a for a in payload.actions if a.action == "leave"):
        key = (action.doctor_id, action.date, action.period)
        if not is_within_window(doctors[action.doctor_id], action.date):
            _skip(action, "outside_doctor_dates")
            continue
        candidates.setdefault(action.doctor_id, []).append(
            (action.date, action.period)
        )
        leave_slots.add(key)
        existing = leave_rows.get(key)
        if existing is not None:
            if existing.notes == action.notes:
                _skip(action, "duplicate")
                continue
            existing.notes = action.notes
            applied += 1
            continue
        entry = LeaveEntry(
            doctor_id=action.doctor_id,
            date=action.date,
            period=action.period,
            notes=action.notes,
        )
        db.add(entry)
        leave_rows[key] = entry
        applied += 1

    for doctor_id, pairs in candidates.items():
        _release_draft_rooms(db, doctor_id, pairs)

    # --- 3. Blocked ------------------------------------------------------
    # Runs after leave (leave wins, same as extra sessions below) and
    # before extra sessions (blocked wins over an extra session on the same
    # cell) -- the leave > blocked > extra_session precedence described in
    # the module docstring. Draft rooms are released the same way leave's
    # are: a blocked doctor is equally not available to hold a room.
    blocked_candidates: dict[int, list[tuple[datetime.date, Period]]] = {}
    blocked_slots: set[tuple[int, datetime.date, Period]] = set()
    for action in (a for a in payload.actions if a.action == "blocked"):
        key = (action.doctor_id, action.date, action.period)
        if not is_within_window(doctors[action.doctor_id], action.date):
            _skip(action, "outside_doctor_dates")
            continue
        if key in leave_rows:
            _skip(action, "leave_exists")
            continue
        blocked_candidates.setdefault(action.doctor_id, []).append(
            (action.date, action.period)
        )
        blocked_slots.add(key)
        existing = blocked_rows.get(key)
        if existing is not None:
            if existing.notes == action.notes:
                _skip(action, "duplicate")
                continue
            existing.notes = action.notes
            applied += 1
            continue
        entry = BlockedEntry(
            doctor_id=action.doctor_id,
            date=action.date,
            period=action.period,
            notes=action.notes,
        )
        db.add(entry)
        blocked_rows[key] = entry
        applied += 1

    for doctor_id, pairs in blocked_candidates.items():
        _release_draft_rooms(db, doctor_id, pairs)

    # --- 4. Extra sessions ---------------------------------------------
    # Runs after leave and blocked have been applied, so a batch adding
    # more than one of them to a cell resolves along the leave > blocked >
    # extra_session precedence, with the loser reported rather than
    # silently winning.
    for action in (a for a in payload.actions if a.action == "extra_session"):
        key = (action.doctor_id, action.date, action.period)
        if not is_within_window(doctors[action.doctor_id], action.date):
            _skip(action, "outside_doctor_dates")
            continue
        if key in leave_rows:
            _skip(action, "leave_exists")
            continue
        if key in blocked_rows:
            _skip(action, "blocked_exists")
            continue
        existing = extra_rows.get(key)
        if existing is not None:
            if existing.notes == action.notes:
                _skip(action, "duplicate")
                continue
            existing.notes = action.notes
            applied += 1
            continue
        entry = ExtraSessionEntry(
            doctor_id=action.doctor_id,
            date=action.date,
            period=action.period,
            notes=action.notes,
        )
        db.add(entry)
        extra_rows[key] = entry
        applied += 1

    # --- 5. Report supersedes ------------------------------------------
    # Every surviving ExtraSessionEntry on a slot this batch's leave
    # covers. Reported, never deleted and never a 409 -- the admin should
    # see what the leave superseded, and the row itself stays as the record
    # of intent (mirrors create_leave_bulk).
    superseded = [
        ExtraSessionOut.model_validate(row)
        for key, row in extra_rows.items()
        if key in leave_slots
    ]
    superseded.sort(key=lambda e: (e.date, e.period.value, e.doctor_id))

    try:
        db.commit()
    except IntegrityError as exc:
        db.rollback()
        raise HTTPException(
            status_code=409,
            detail=(
                "A leave, blocked, or extra session entry in this batch was "
                "created concurrently; please retry."
            ),
        ) from exc

    skipped.sort(key=lambda s: (s.date, s.period.value, s.doctor_id, s.action))
    return PlanningBulkOut(
        applied=applied, skipped=skipped, superseded_extra_sessions=superseded
    )
