"""Staging schemas (staging plan, Task 3).

Field names on StagingCreateIn deliberately mirror GenerateRotaIn
(start_date, num_weeks, template_start_week): the create payload has the
same shape as a generate request, since a staging is created from exactly
the same inputs generation would take, before generation actually runs
(see the staging plan's Design Decision 4 for why template_start_week is
applied once at copy time and then discarded -- the persisted RotaConfig
always has template_start_week=1).

StagingSessionOut is MasterRotaSessionOut plus is_on_leave: a staging row
has a real calendar date (via its config's start_date), so leave -- unlike
on the master template -- is something the editor can and should show.

is_extra_session (extra sessions plan, Task 2, Design Decision 8) is
derived the same way, from ExtraSessionEntry, and means "a planned extra
session exists for this doctor/date/period" -- not "this row was produced
by the override". Those diverge whenever the override did not fire (the
template row was already working, leave blocked it, the entry was added
after staging started, or the cell was edited back), so the frontend
badge is labelled accordingly rather than implying the row's origin.

StagingSessionPatchIn / StagingSessionCreateIn subclass MasterSessionPairIn
from schemas/master_rota.py so the (session_type, room_id) pair validation
cannot drift between the two grids.
"""
import datetime
from typing import Literal

from pydantic import BaseModel, Field

from ...models.enums import Day, DoctorType, MasterSessionType, Period
from .closure import ClosedSlotOut
from .master_rota import MasterSessionPairIn


class StagingCreateIn(BaseModel):
    start_date: datetime.date
    num_weeks: Literal[1, 2, 4]
    template_start_week: int = Field(default=1, ge=1, le=4)


class StagingSessionOut(BaseModel):
    """One staging slot. doctor_code / room_code / is_on_leave are joined
    in the router, matching MasterRotaSessionOut's pattern plus the one
    addition real dates make possible."""
    session_id: int
    doctor_id: int
    doctor_code: str
    doctor_type: DoctorType
    week: int
    day: Day
    period: Period
    session_type: MasterSessionType
    room_id: int | None = None
    room_code: str | None = None
    is_on_leave: bool
    is_extra_session: bool


class StagingOut(BaseModel):
    """GET /staging/active and the response of every staging write
    endpoint's underlying staging. closed_slots is live PracticeClosure
    data (half-day granularity) in the create-to-complete range -- not a
    snapshot, since none exists yet for a staging (staging plan, Design
    Decision 10)."""
    staging_id: int
    config_id: int
    start_date: datetime.date
    num_weeks: int
    created_at: datetime.datetime
    completed_at: datetime.datetime | None = None
    closed_slots: list[ClosedSlotOut] = Field(default_factory=list)
    sessions: list[StagingSessionOut]


class StagingSessionPatchIn(MasterSessionPairIn):
    """PATCH /staging/{staging_id}/sessions/{session_id}. Verbatim pair
    setter, same contract as MasterSessionPatchIn."""


class StagingSessionCreateIn(MasterSessionPairIn):
    """POST /staging/{staging_id}/sessions. Adds the slot coordinates on
    top of the shared pair validator, same as MasterSessionCreateIn.
    week is bounded 1..4 by the field constraint; the router additionally
    422s when week exceeds this staging's own num_weeks (Design Decision 9
    -- the 1..4 schema bound is necessary but not sufficient for a 1- or
    2-week staging)."""
    doctor_id: int
    week: int = Field(ge=1, le=4)
    day: Day
    period: Period


class StagingSessionWriteOut(BaseModel):
    session: StagingSessionOut
    displaced_session: StagingSessionOut | None