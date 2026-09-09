"""Reception role counters over a rolling window (reception counters, Task 1).

The single implementation of "how much of each role has each reception staff
member done lately". `GET /reception/counters` calls it today; a future
front-desk-rotation generator will call it as its fairness input. Both go
through `compute_role_counters` rather than re-deriving the aggregate, so the
API and the generator can never disagree about what a counter means.

**Derived at read time, never stored.** This is the deliberate divergence from
the clinical side's `clinic_counters` / `counter_snapshots` tables. A rolling
window cannot be maintained as a running total: a stored counter can be
incremented and decremented but has no way to forget a day that ages out of
the window, so it would have to be rebuilt from `reception_rota_sessions`
anyway -- making the table a cache of a derived number rather than a source of
truth. The assignment history is already durable: `reception_rota_sessions`
*is* the counter history. The clinical tables exist for reasons reception does
not share (the engine reads counters mid-run as a tie-break, and the values are
cumulative forever, which is what makes the snapshot lifecycle necessary);
reception has no draft/commit lifecycle to hang a snapshot off -- "Regenerate"
is DELETE then POST -- so a stored reception counter would need correct
decrements on every session delete, day delete and cascade, with no snapshot to
restore from when one was missed. Deriving removes that class of drift bug
rather than defending against it.

One consequence to know rather than to fix: deleting a generated day deletes
that day's contribution, because the sessions *are* the history. That is the
correct reading -- a regenerated day's old assignments did not happen -- but it
does mean the counters move when a past day is regenerated.

If the aggregate ever does become slow (one window is roughly 4,400 rows at
this practice's scale), a materialised table can be introduced behind this
function without changing a single caller. No new index is needed today:
`uq_reception_rotas_date` serves the date filter, `uq_rrs_slot` is
`rota_id`-leading so the sessions join is indexed, and `uq_rle_slot` serves the
leave anti-join. The `GROUP BY` itself is a hash/sort over the window's rows
and deliberately has no index of its own.

This module returns counts and hours only. It computes no ratios at all --
the weighted score (`role_hours / hours_worked`) and its display rules live
with the display, in the frontend.
"""
from __future__ import annotations

import datetime
from dataclasses import dataclass, field

from sqlalchemy import distinct, func, select
from sqlalchemy.orm import Session

from .models import (
    ReceptionLeaveEntry,
    ReceptionRota,
    ReceptionRotaSession,
    ReceptionStaff,
)
from .models.enums import ReceptionRole

# Roles that do not count toward hours worked. Matches ReceptionHoursPage's
# existing rule exactly, so the page's two hours figures cannot disagree about
# what "working" means -- `lunch` therefore counts as working time, as it does
# there today. That is a deliberate choice with a known cost (it inflates the
# denominator and dilutes every role's proportion by a few percent, uniformly
# for everyone), and this set is the single place to change it if lunch is ever
# reclassified.
_NON_WORKING_ROLES: frozenset[ReceptionRole] = frozenset({ReceptionRole.NOT_WORKING})

_HOURS_PER_SLOT = 0.5


def default_counter_window(today: datetime.date) -> tuple[datetime.date, datetime.date]:
    """The default window: the four complete preceding weeks plus the current
    week to date -- `(monday_of(today) - 4 weeks, today)`.

    `today` is a parameter rather than a `date.today()` call inside, so the
    rule is testable in isolation and has exactly one definition.

    Two properties worth stating because they surprise on first reading:
    the window is 29-33 days long depending on which weekday it is computed
    on (it is anchored to a Monday, not to `today - 28 days`), and today's own
    rota counts even though the day is not over. Both are accepted -- every
    staff member is measured over the *same* window, which is what a fairness
    comparison needs -- and `RoleCounters.days_counted` is returned so a
    reader can interpret the absolute numbers rather than being mystified by
    them. Future-dated generated days are excluded, so generating a week ahead
    does not pollute the fairness picture with assignments that have not
    happened.
    """
    monday = today - datetime.timedelta(days=today.weekday())
    return monday - datetime.timedelta(weeks=4), today


def assignment_counter_window(
    rota_date: datetime.date,
) -> tuple[datetime.date, datetime.date]:
    """The window the front-desk assignment generator uses as its fairness
    input: `(monday_of(rota_date) - 4 weeks, rota_date)` -- the same shape as
    `default_counter_window`, but anchored to the *rota's* date rather than to
    today.

    The page's window is deliberately wrong for the generator. Its final bound
    is `today`, which excludes future-dated generated days so that generating a
    week ahead does not pollute the counters page with assignments that have
    not happened. Run the generator over a week generated ahead of today and
    every day in the batch falls outside that window: assigning Tuesday cannot
    see the `front_desk` rows written to Monday minutes earlier, so every day
    in the batch reads identical counters and picks the same person, five days
    running. Anchoring the upper bound to the rota's own date makes each day in
    a batch see the days before it, which is what makes the rotation rotate.

    The same anchoring makes assignment reproducible: the window depends only
    on the day being assigned, so re-running against unchanged data a month
    later gives the same answer rather than drifting with the calendar.

    `compute_role_counters` needs no change to support this -- it has no notion
    of "today" at all, and the future-date exclusion lives entirely in
    `default_counter_window`, where it must stay so `GET /reception/counters`
    is unaffected.
    """
    monday = rota_date - datetime.timedelta(days=rota_date.weekday())
    return monday - datetime.timedelta(weeks=4), rota_date


@dataclass
class StaffRoleCounters:
    """One staff member's counters for the window.

    `role_slots` is zero-filled for all thirteen `ReceptionRole` values, so
    callers never have to default a missing key. Every role is counted,
    `not_working` included -- a count of not-working slots is a real fact and
    suppressing one role would be a special case with no rule behind it.
    """

    staff_id: int
    code: str
    active: bool
    role_slots: dict[ReceptionRole, int] = field(default_factory=dict)
    hours_worked: float = 0.0
    days_present: int = 0


@dataclass
class RoleCounters:
    """The window's bounds, its generated-day count, and one row per staff
    member ordered by code.

    `days_counted` is the number of distinct generated dates in range, not the
    number of days in the window: a window with sparse generation contributes
    fewer days rather than reaching further back, and that is a fact the page
    should show rather than hide.
    """

    from_date: datetime.date
    to_date: datetime.date
    days_counted: int
    staff: list[StaffRoleCounters]


def compute_role_counters(
    db: Session, from_date: datetime.date, to_date: datetime.date
) -> RoleCounters:
    """Per-staff role slot counts, hours worked, and days present over the
    inclusive date range `[from_date, to_date]`.

    Leave is excluded from numerator *and* denominator: a staff member's rows
    on a date they have a `ReceptionLeaveEntry` count toward neither their role
    counts, nor their hours, nor their `days_present`. Their rows stay on the
    day exactly as generated -- this is a reading of the data, not a change to
    it -- and because the value is computed at read time, leave entered *after*
    a day was generated is picked up automatically, with no leave-router change
    needed.

    Every staff member with rows in the window appears, active or not, so a
    recently deactivated person's history stays visible; every active staff
    member with no rows appears zero-filled, so a new starter reads as 0 rather
    than vanishing. `active` is carried through so the caller can label them.
    A *deleted* person's history does not stay visible, though: deleting a
    staff member purges their `reception_rota_sessions` rows (see
    `api/routers/reception_staff.py`), and these figures are derived from rows
    that no longer exist, so past windows lose them entirely.
    """
    staff_rows = db.execute(
        select(ReceptionStaff).order_by(ReceptionStaff.code, ReceptionStaff.id)
    ).scalars().all()
    staff_by_id = {s.id: s for s in staff_rows}

    days_counted = db.execute(
        select(func.count(distinct(ReceptionRota.date))).where(
            ReceptionRota.date >= from_date, ReceptionRota.date <= to_date
        )
    ).scalar_one()

    # One grouped pass over the window, pivoted in Python rather than emitted
    # as thirteen conditional aggregates. The LEFT JOIN + IS NULL is the leave
    # anti-join; portable Core constructs only, since this runs on SQLite in
    # tests and Postgres in production.
    grouped = db.execute(
        select(
            ReceptionRotaSession.staff_id,
            ReceptionRotaSession.role,
            func.count().label("slots"),
        )
        .join(ReceptionRota, ReceptionRota.id == ReceptionRotaSession.rota_id)
        .outerjoin(
            ReceptionLeaveEntry,
            (ReceptionLeaveEntry.staff_id == ReceptionRotaSession.staff_id)
            & (ReceptionLeaveEntry.date == ReceptionRota.date),
        )
        .where(
            ReceptionRota.date >= from_date,
            ReceptionRota.date <= to_date,
            ReceptionLeaveEntry.id.is_(None),
        )
        .group_by(ReceptionRotaSession.staff_id, ReceptionRotaSession.role)
    ).all()

    # days_present cannot come off the grouped query above: those groups are
    # per (staff, role), so a staff member working two roles on one date would
    # count that date twice. Distinct (staff, date) pairs instead, over the
    # same leave-filtered join.
    present_dates = db.execute(
        select(ReceptionRotaSession.staff_id, ReceptionRota.date)
        .join(ReceptionRota, ReceptionRota.id == ReceptionRotaSession.rota_id)
        .outerjoin(
            ReceptionLeaveEntry,
            (ReceptionLeaveEntry.staff_id == ReceptionRotaSession.staff_id)
            & (ReceptionLeaveEntry.date == ReceptionRota.date),
        )
        .where(
            ReceptionRota.date >= from_date,
            ReceptionRota.date <= to_date,
            ReceptionLeaveEntry.id.is_(None),
        )
        .distinct()
    ).all()

    counters: dict[int, StaffRoleCounters] = {}

    def _row_for(staff_id: int) -> StaffRoleCounters | None:
        existing = counters.get(staff_id)
        if existing is not None:
            return existing
        staff = staff_by_id.get(staff_id)
        if staff is None:  # pragma: no cover - FK makes this unreachable
            return None
        row = StaffRoleCounters(
            staff_id=staff.id,
            code=staff.code,
            active=staff.active,
            role_slots={role: 0 for role in ReceptionRole},
        )
        counters[staff_id] = row
        return row

    # Active staff always appear, zero-filled, even with no rows in the window.
    for staff in staff_rows:
        if staff.active:
            _row_for(staff.id)

    for staff_id, role, slots in grouped:
        row = _row_for(staff_id)
        if row is None:  # pragma: no cover
            continue
        row.role_slots[role] += slots
        if role not in _NON_WORKING_ROLES:
            row.hours_worked += slots * _HOURS_PER_SLOT

    day_counts: dict[int, set[datetime.date]] = {}
    for staff_id, date in present_dates:
        day_counts.setdefault(staff_id, set()).add(date)
    for staff_id, dates in day_counts.items():
        row = _row_for(staff_id)
        if row is None:  # pragma: no cover
            continue
        row.days_present = len(dates)

    ordered = sorted(counters.values(), key=lambda r: (r.code, r.staff_id))
    return RoleCounters(
        from_date=from_date,
        to_date=to_date,
        days_counted=days_counted,
        staff=ordered,
    )
