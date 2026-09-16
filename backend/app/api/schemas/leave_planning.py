"""Leave planning schemas.

Backs the month-at-a-time planning grid: a read-only per-(date, period)
clinical headcount, and a batched write applying leave / extra-session /
blocked / clear actions in one transaction.

Deliberately a separate module from `leave.py` rather than an extension of
it -- `/leave` remains the ad-hoc, one-off path during the year, and its
range-shaped schemas have nothing in common with the cell-shaped ones
here.
"""
import datetime
from typing import Literal

from pydantic import BaseModel, Field

from ...models.blocked import NOTES_MAX_LENGTH
from ...models.enums import ExtraSessionCompensation, Period
from .extra_session import ExtraSessionOut

# The grid asks for one calendar month. The cap exists so this cannot be
# used as an unbounded scan of the whole leave table; measured as
# `(to_date - from_date).days`, matching LeaveBulkIn's MAX_BULK_RANGE_DAYS
# convention.
MAX_COVERAGE_RANGE_DAYS = 62

# One month of a ~12-doctor grid is ~1000 cells; 2000 leaves headroom
# without letting a client post an unbounded batch.
MAX_PLANNING_ACTIONS = 2000

PlanningAction = Literal["leave", "extra_session", "blocked", "clear"]

PlanningSkipReason = Literal[
    "duplicate",
    "outside_doctor_dates",
    "leave_exists",
    "blocked_exists",
    "nothing_to_clear",
    "toil_not_entitled",
]


class CoverageSlotOut(BaseModel):
    """Clinical headcount for one (date, period).

    `headcount` counts Partner and Salaried doctors only whose
    effective session type is REQUIRES_ROOM or PRE_ASSIGNED. A
    closed slot always reports `headcount=0` alongside `is_closed=True` --
    the grid renders that as "-", not as "uncovered".
    """

    date: datetime.date
    period: Period
    headcount: int
    is_closed: bool


class PlanningActionIn(BaseModel):
    doctor_id: int
    date: datetime.date
    period: Period
    action: PlanningAction
    # Free-text cell note (12-char cap, matching the grid cell's display
    # limit). Only meaningful for "leave" / "extra_session" / "blocked" --
    # ignored for "clear", which has no row left to hold it.
    notes: str | None = Field(default=None, max_length=NOTES_MAX_LENGTH)
    # How the extra session is compensated. Only meaningful for
    # "extra_session" (the way `notes` is meaningless for "clear"), and
    # nullable with a very specific meaning: **Payment on insert, unchanged
    # on update**.
    #
    # Unlike ExtraSessionIn's defaulted field, an omitted value here must not
    # mean Payment. This endpoint is a state-setting grid that emits an
    # `extra_session` action for *any* change to the cell, a notes-only edit
    # included, so a client that has not been updated -- or any later code
    # path emitting an action without the field -- would silently downgrade a
    # TOIL row to Payment and quietly delete a leave credit. A null that means
    # "don't touch" cannot do that. `notes` has the same shape of hazard and
    # accepts it; a note is not worth a session of leave.
    compensation: ExtraSessionCompensation | None = None


class PlanningBulkIn(BaseModel):
    actions: list[PlanningActionIn] = Field(max_length=MAX_PLANNING_ACTIONS)


class PlanningSkippedOut(BaseModel):
    """One action the batch declined to apply, and why.

    Skipping rather than failing is the whole point: one stale cell must
    not 422 a 200-cell save.
    """

    doctor_id: int
    date: datetime.date
    period: Period
    action: PlanningAction
    reason: PlanningSkipReason


class PlanningBulkOut(BaseModel):
    applied: int
    skipped: list[PlanningSkippedOut]
    superseded_extra_sessions: list[ExtraSessionOut]
