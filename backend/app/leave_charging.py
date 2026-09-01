"""Leave chargeability rule (no-surgery leave exemption plan, Task 2).

A booked `LeaveEntry` slot is **exempt** (not chargeable against the doctor's
leave) when any of the following holds, checked in this precedence order:

1. The date is a Saturday or Sunday -> ``EXEMPT_WEEKEND``.
2. The doctor has no week-1 template row for ``(weekday, period)`` ->
   ``EXEMPT_NO_TEMPLATE_ROW``.
3. That row's session type is ``NO_SURGERY`` -> ``EXEMPT_NO_SURGERY``.
4. ``(date, period)`` is in the closed set -> ``EXEMPT_CLOSED``.

Otherwise the slot is chargeable. ``REQUIRES_ROOM``, ``PRE_ASSIGNED``,
``ADMIN_TIME`` and ``WFH`` are all chargeable -- the doctor was due to be at
work, whatever they were doing that session.

This is a *different* question from `leave_planning.get_coverage`'s
headcount, which only counts `REQUIRES_ROOM` / `PRE_ASSIGNED` as covering
(`_COUNTED_TYPES`, `app/api/routers/leave_planning.py`) -- coverage asks
whether a clinician is available to see patients, charging asks whether the
doctor was due to be at work at all. The two predicates are not shared and
must not be merged; only the week-1 template map (`app/master_template.py`)
is shared between them.

`app/calendar_feed.py` asks the same "was the doctor due to be at work?"
question and lands on the same set (`REQUIRES_ROOM`, `PRE_ASSIGNED`,
`ADMIN_TIME`, `WFH` in, `NO_SURGERY` out). That alignment is intentional and
deliberately **not** shared as a common predicate: this module reads the
*live week-1 master template* by weekday, because it is asked about a bare
date with no rota, while the feed reads the *persisted `template_type`
snapshot* on a real `RotaSession` row. One function would force one of them
onto the wrong source.

Chargeability is computed at read time from the live template and closure
tables, never stored on `LeaveEntry`: both tables are editable, and
baking the answer in at booking time would leave rows asserting a pattern
the practice no longer works.
"""
from __future__ import annotations

import datetime
from collections.abc import Container, Iterable, Mapping
from dataclasses import dataclass, field

from .master_template import WEEKDAY_MAX, DAY_BY_WEEKDAY
from .models.enums import Day, MasterSessionType, Period

# Declared in computation-precedence order. `LeaveExemptionsOut` deliberately
# orders its fields differently for display (closure first, as the most
# legible reason to an admin) -- that mismatch between computation order and
# display order is intentional, not a bug to "fix".
EXEMPT_WEEKEND = "weekend"
EXEMPT_NO_TEMPLATE_ROW = "no_template_row"
EXEMPT_NO_SURGERY = "no_surgery"
EXEMPT_CLOSED = "closed"

_ALL_REASONS = (EXEMPT_WEEKEND, EXEMPT_NO_TEMPLATE_ROW, EXEMPT_NO_SURGERY, EXEMPT_CLOSED)


def exemption_reason(
    doctor_id: int,
    day: datetime.date,
    period: Period,
    template: Mapping[tuple[int, Day, Period], MasterSessionType],
    closed: Container[tuple[datetime.date, Period]],
) -> str | None:
    """The exemption reason for one slot, or `None` if it is chargeable."""
    # Explicit early return before any `DAY_BY_WEEKDAY` lookup: `POST /leave`
    # is not weekday-filtered (only the bulk endpoints are), so a stray
    # Saturday/Sunday row is representable and indexing DAY_BY_WEEKDAY with
    # it would KeyError into a 500.
    if day.weekday() > WEEKDAY_MAX:
        return EXEMPT_WEEKEND

    day_enum = DAY_BY_WEEKDAY[day.weekday()]
    session_type = template.get((doctor_id, day_enum, period))
    if session_type is None:
        return EXEMPT_NO_TEMPLATE_ROW
    if session_type is MasterSessionType.NO_SURGERY:
        return EXEMPT_NO_SURGERY
    if (day, period) in closed:
        return EXEMPT_CLOSED
    return None


@dataclass(frozen=True)
class ChargingSummary:
    total_entries: int
    chargeable_sessions: int
    exempt_by_reason: dict[str, int] = field(default_factory=dict)


def summarise_leave_charging(
    entries: Iterable,
    template: Mapping[tuple[int, Day, Period], MasterSessionType],
    closed: Container[tuple[datetime.date, Period]],
) -> ChargingSummary:
    """Totals a `LeaveEntry` iterable against the exemption rule.

    Reads `doctor_id` off each entry rather than taking one as a parameter,
    so a mixed-doctor iterable summarises correctly with no change -- the
    property the later multi-doctor register view relies on.
    """
    exempt_by_reason = {reason: 0 for reason in _ALL_REASONS}
    total = 0
    chargeable = 0
    for entry in entries:
        total += 1
        reason = exemption_reason(
            entry.doctor_id, entry.date, entry.period, template, closed
        )
        if reason is None:
            chargeable += 1
        else:
            exempt_by_reason[reason] += 1
    return ChargingSummary(
        total_entries=total,
        chargeable_sessions=chargeable,
        exempt_by_reason=exempt_by_reason,
    )
