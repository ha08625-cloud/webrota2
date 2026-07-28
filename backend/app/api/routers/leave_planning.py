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
"""
from __future__ import annotations

import datetime

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from ...doctor_window import is_within_window
from ...engine.week_map import DAY_ORDER
from ...models import (
    Doctor,
    ExtraSessionEntry,
    LeaveEntry,
    MasterRotaSession,
    MasterRotaTemplate,
    PracticeClosure,
)
from ...models.enums import Day, DoctorType, MasterSessionType, Period
from ..deps import get_current_user, get_db
from ..schemas import (
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

_WEEKDAY_MAX = 4  # Mon=0 ... Fri=4 (Python date.weekday())

# `date.weekday()` -> Day, inverted from week_map's canonical ordering.
# Module-local rather than a new shared helper: the engine maps generation
# weeks onto dates, never a bare calendar date onto a template day, so
# there is nothing here for it to reuse.
_DAY_BY_WEEKDAY: dict[int, Day] = {offset: day for day, offset in DAY_ORDER.items()}

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
_PLANNING_DOCTOR_TYPES = frozenset({DoctorType.PARTNER, DoctorType.SALARIED})


def _weekdays(start: datetime.date, end: datetime.date) -> list[datetime.date]:
    """Every Mon-Fri date in the inclusive range. Weekends are omitted from
    the coverage response entirely rather than returned as zero -- the grid
    has no weekend columns."""
    days: list[datetime.date] = []
    for offset in range((end - start).days + 1):
        day = start + datetime.timedelta(days=offset)
        if day.weekday() <= _WEEKDAY_MAX:
            days.append(day)
    return days


def _week_one_template(db: Session) -> dict[tuple[int, Day, Period], MasterSessionType]:
    """The active template's week-1 rows, keyed (doctor_id, day, period).

    Week 1 only, and treated as the working pattern for every calendar date
    (Design Decision 1): mapping a date onto the 4-week cycle needs a
    `start_week`, and the only source of one is `RotaConfig.template_start_week`
    -- a per-run value with no calendar anchor. Partner and salaried doctors
    work the same sessions every week, so week 1 is the right answer for
    leave planning even though the schema keeps four weeks.

    The template is resolved the way `GET /master-rota/active` resolves it
    -- lowest id among active rows -- because `is_active` is not
    schema-enforced unique and this endpoint must not 500 where that one
    renders. No active template at all yields an empty map, so every slot
    reports a headcount of 0 and the grid still draws its leave cells.
    """
    template = db.execute(
        select(MasterRotaTemplate)
        .where(MasterRotaTemplate.is_active.is_(True))
        .order_by(MasterRotaTemplate.id)
    ).scalars().first()
    if template is None:
        return {}

    rows = db.execute(
        select(MasterRotaSession).where(
            MasterRotaSession.template_id == template.id,
            MasterRotaSession.week == 1,
        )
    ).scalars().all()
    return {(r.doctor_id, r.day, r.period): r.session_type for r in rows}


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
    template = _week_one_template(db)
    leave = _slot_keys(db, LeaveEntry, from_date, to_date)
    extra = _slot_keys(db, ExtraSessionEntry, from_date, to_date)
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
        day_enum = _DAY_BY_WEEKDAY[day.weekday()]
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
                if slot in leave:
                    # Leave wins, and skips the extra-session override
                    # entirely (extra sessions plan, Design Decision 6).
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


@router.post("/bulk", response_model=PlanningBulkOut, status_code=200)
def apply_planning_bulk(
    payload: PlanningBulkIn,
    db: Session = Depends(get_db),
    user: dict = Depends(get_current_user),
) -> PlanningBulkOut:
    """Apply a batch of planning-grid edits in one transaction.

    Actions are applied in a fixed order -- **clears, then leave, then
    extra sessions** (Design Decision 9) -- so a batch touching both sides
    of a slot resolves deterministically in leave's favour, matching
    `extra_sessions.md` Decision 6.

    Nothing here 409s on a state that already matches: the grid sends the
    state it wants, so setting leave where leave already exists is a
    "duplicate" skip, not a failure. A pre-existing `ExtraSessionEntry` the
    batch's leave covers is *reported* in `superseded_extra_sessions` --
    never deleted, never blocked -- exactly as `create_leave_bulk` does.

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
        if action.date.weekday() > _WEEKDAY_MAX:
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
    # Both rows are keyed on the same (doctor_id, date, period) triple, so
    # a clear removes whichever of them exists with nothing to
    # disambiguate. Draft rooms are deliberately not restored (Design
    # Decision 10).
    for action in (a for a in payload.actions if a.action == "clear"):
        key = (action.doctor_id, action.date, action.period)
        removed = False
        for rows in (leave_rows, extra_rows):
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
        if key in leave_rows:
            _skip(action, "duplicate")
            continue
        entry = LeaveEntry(
            doctor_id=action.doctor_id, date=action.date, period=action.period
        )
        db.add(entry)
        leave_rows[key] = entry
        applied += 1

    for doctor_id, pairs in candidates.items():
        _release_draft_rooms(db, doctor_id, pairs)

    # --- 3. Extra sessions ---------------------------------------------
    # Runs after leave has been applied, so a batch adding both to one cell
    # resolves in leave's favour with the extra session reported as
    # "leave_exists" rather than silently winning.
    for action in (a for a in payload.actions if a.action == "extra_session"):
        key = (action.doctor_id, action.date, action.period)
        if not is_within_window(doctors[action.doctor_id], action.date):
            _skip(action, "outside_doctor_dates")
            continue
        if key in leave_rows:
            _skip(action, "leave_exists")
            continue
        if key in extra_rows:
            _skip(action, "duplicate")
            continue
        entry = ExtraSessionEntry(
            doctor_id=action.doctor_id, date=action.date, period=action.period
        )
        db.add(entry)
        extra_rows[key] = entry
        applied += 1

    # --- 4. Report supersedes ------------------------------------------
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
                "A leave or extra session entry in this batch was created "
                "concurrently; please retry."
            ),
        ) from exc

    skipped.sort(key=lambda s: (s.date, s.period.value, s.doctor_id, s.action))
    return PlanningBulkOut(
        applied=applied, skipped=skipped, superseded_extra_sessions=superseded
    )
