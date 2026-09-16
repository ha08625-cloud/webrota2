"""The TOIL credit rule for extra sessions.

An `ExtraSessionEntry` whose `compensation` is `TOIL` credits **+1 session**
to that doctor's leave entitlement for the calendar year the session falls
in. A `PAYMENT` entry credits nothing. One weekday extra session is one
session -- extra sessions are half days and leave is counted in sessions
throughout, so the credit is always exactly 1.0, never 0.5 and never a day.

The credit is **withheld** when the session plainly did not happen. An extra
session records *intent*, and a planned one can be overtaken by events after
it is created, so the exclusions are checked in this precedence order:

1. The doctor has leave booked on the slot -> ``SKIP_ON_LEAVE``. Both bulk
   leave endpoints leave a covering extra session in place and merely report
   it as ``superseded_extra_sessions``; leave wins in the staging copy loop,
   so the doctor does not work the session.
2. The doctor has a blocked row on the slot -> ``SKIP_BLOCKED``.
3. ``(date, period)`` is a practice closure -> ``SKIP_CLOSED``.
4. The date falls outside the doctor's employment window ->
   ``SKIP_OUTSIDE_WINDOW``. Both create paths refuse an out-of-window date up
   front, but `Doctor.start_date` / `end_date` are editable afterwards.

Weekends need no exclusion: both create paths reject them, and no later edit
can turn a weekday into a Saturday.

## This is not `leave_charging.exemption_reason`, and must not reuse it

A future reader will want to merge the two, and they must not be. That
predicate exempts a slot whose week-1 template row is `NO_SURGERY` or
missing -- which is precisely the *normal* case for an extra session, the
whole point being a doctor working a slot they do not normally work.
Reusing it would zero almost every credit. This predicate is its own,
smaller thing: leave on the slot, blocked on the slot, a closure on the
slot, or outside the employment window. It reads no template at all.

## The `BlockedEntry` caveat

``SKIP_BLOCKED`` is the one exclusion that does not follow from what the
rest of the system does. `BlockedEntry` is planner-only: nothing in
`POST /staging` or under `engine/` reads it, so a blocked slot carrying an
extra session **is still copied into staging**. The exclusion is therefore a
judgement about what the admin meant, not a consequence of the copy loop. It
is made because blocked is the state the planner already treats as "not
available", and because a credit that outlives an explicit unavailability
marker is the harder one to explain to a doctor.

The week-1 template row is deliberately *not* a fifth exclusion, even though
the `POST /staging` copy loop only turns an extra session into a working slot
on an absent or overridable row (`NO_SURGERY` / `ADMIN_TIME` / `WFH`), which
makes the session a no-op on a `REQUIRES_ROOM` or `PRE_ASSIGNED` row. An
extra session is a decision between the doctor and the practice, and the
template is a separate artefact that is often behind -- a credit that
silently vanished because someone later filled in a template row would be
harder to explain than an occasional over-credit an admin can correct with
`adjustment_sessions`. Revisit if over-credits are actually observed.

Like `leave_charging.py`, this is a pure per-entry predicate plus a
summariser with no DB access: the rules carry the design decisions and are
worth unit-testing without a `TestClient`.
"""
from __future__ import annotations

import datetime
from collections.abc import Container, Iterable, Mapping
from dataclasses import dataclass, field
from decimal import Decimal

from .doctor_window import _HasWindow, is_within_window
from .models.enums import ExtraSessionCompensation, Period

# Declared in computation-precedence order, matching `leave_charging`'s
# `_ALL_REASONS`. `ToilSkipsOut` orders its fields the same way.
SKIP_ON_LEAVE = "on_leave"
SKIP_BLOCKED = "blocked"
SKIP_CLOSED = "closed"
SKIP_OUTSIDE_WINDOW = "outside_window"

_ALL_REASONS = (SKIP_ON_LEAVE, SKIP_BLOCKED, SKIP_CLOSED, SKIP_OUTSIDE_WINDOW)

# One weekday extra session is worth exactly one leave session.
CREDIT_PER_SESSION = Decimal("1.0")


def credit_skip_reason(
    doctor_id: int,
    day: datetime.date,
    period: Period,
    leave_slots: Container[tuple[int, datetime.date, Period]],
    blocked_slots: Container[tuple[int, datetime.date, Period]],
    closed: Container[tuple[datetime.date, Period]],
    doctor: _HasWindow | None,
) -> str | None:
    """Why this slot earns no TOIL credit, or `None` if it earns one.

    Says nothing about `compensation`: a Payment entry is filtered out by
    `summarise_toil_credit` before it gets here, so this answers only "did
    the doctor actually work this session".

    `doctor` may be `None` when the doctor is not known to the caller, in
    which case the window check is skipped rather than guessed at -- the
    other three exclusions still apply.
    """
    slot = (doctor_id, day, period)
    if slot in leave_slots:
        return SKIP_ON_LEAVE
    if slot in blocked_slots:
        return SKIP_BLOCKED
    if (day, period) in closed:
        return SKIP_CLOSED
    if doctor is not None and not is_within_window(doctor, day):
        return SKIP_OUTSIDE_WINDOW
    return None


@dataclass(frozen=True)
class ToilCreditSummary:
    """What a doctor's extra sessions earned them in leave.

    `credited_sessions` is a `Decimal` even though it is always integral, so
    it composes with `leave_entitlement.py`'s other addends without a cast at
    every call site. `toil_entries` is the raw count of TOIL rows, credited
    or not, so `toil_entries - skipped` reconstructs the credit.
    """

    credited_sessions: Decimal
    toil_entries: int
    skipped_by_reason: dict[str, int] = field(default_factory=dict)


def summarise_toil_credit(
    entries: Iterable,
    leave_slots: Container[tuple[int, datetime.date, Period]],
    blocked_slots: Container[tuple[int, datetime.date, Period]],
    closed: Container[tuple[datetime.date, Period]],
    doctors_by_id: Mapping[int, _HasWindow],
) -> ToilCreditSummary:
    """Totals an `ExtraSessionEntry` iterable against the credit rule.

    Payment entries are filtered *here* rather than by the caller, so one
    call answers "how much TOIL did this doctor earn" from their whole
    extra-session list.

    Reads `doctor_id` off each entry rather than taking one as a parameter,
    so a mixed-doctor iterable summarises correctly -- the same shape as
    `leave_charging.summarise_leave_charging`.
    """
    skipped_by_reason = {reason: 0 for reason in _ALL_REASONS}
    toil_entries = 0
    credited = Decimal("0.0")
    for entry in entries:
        if entry.compensation is not ExtraSessionCompensation.TOIL:
            continue
        toil_entries += 1
        reason = credit_skip_reason(
            entry.doctor_id,
            entry.date,
            entry.period,
            leave_slots,
            blocked_slots,
            closed,
            doctors_by_id.get(entry.doctor_id),
        )
        if reason is None:
            credited += CREDIT_PER_SESSION
        else:
            skipped_by_reason[reason] += 1
    return ToilCreditSummary(
        credited_sessions=credited,
        toil_entries=toil_entries,
        skipped_by_reason=skipped_by_reason,
    )
