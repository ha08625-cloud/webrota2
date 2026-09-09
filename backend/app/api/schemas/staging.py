"""Staging schemas.

Field names on StagingCreateIn deliberately mirror GenerateRotaIn
(start_date, num_weeks, template_start_week): the create payload has the
same shape as a generate request, since a staging is created from exactly
the same inputs generation would take, before generation actually runs
(template_start_week is applied once at copy time and then discarded --
the persisted RotaConfig always has template_start_week=1).

StagingSessionOut is MasterRotaSessionOut plus is_on_leave: a staging row
has a real calendar date (via its config's start_date), so leave -- unlike
on the master template -- is something the editor can and should show.

is_extra_session is derived the same way, from ExtraSessionEntry, and
means "a planned extra session exists for this doctor/date/period" -- not
"this row was produced by the override". Those diverge whenever the
override did not fire (the template row was already working, leave
blocked it, the entry was added after staging started, or the cell was
edited back), so the frontend badge is labelled accordingly rather than
implying the row's origin.

StagingSessionPatchIn / StagingSessionCreateIn subclass MasterSessionPairIn
from schemas/master_rota.py so the (session_type, room_id) pair validation
cannot drift between the two grids.

StagingNoteIn / StagingNotePatchIn / StagingNoteOut are the per-run note
instances (see models/recurring_note.py). They carry `week` as a
*generation* week of this run: the ge/le 1..4 field bound is necessary
but not sufficient, so the router additionally 422s when week exceeds the
staging's own num_weeks, exactly as StagingSessionCreateIn does.
StagingNotePatchIn omits source_note_id -- provenance is fixed at pick
time; re-pointing an instance at a different definition would claim a
copy that never happened.
"""
import datetime
from typing import Literal

from pydantic import BaseModel, Field, field_validator

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
    snapshot, since none exists yet for a staging."""
    staging_id: int
    config_id: int
    start_date: datetime.date
    num_weeks: int
    created_at: datetime.datetime
    completed_at: datetime.datetime | None = None
    closed_slots: list[ClosedSlotOut] = Field(default_factory=list)
    sessions: list[StagingSessionOut]
    notes: list["StagingNoteOut"] = Field(default_factory=list)


class StagingSessionPatchIn(MasterSessionPairIn):
    """PATCH /staging/{staging_id}/sessions/{session_id}. Verbatim pair
    setter, same contract as MasterSessionPatchIn."""


class StagingSessionCreateIn(MasterSessionPairIn):
    """POST /staging/{staging_id}/sessions. Adds the slot coordinates on
    top of the shared pair validator, same as MasterSessionCreateIn.
    week is bounded 1..4 by the field constraint; the router additionally
    422s when week exceeds this staging's own num_weeks (the 1..4 schema
    bound is necessary but not sufficient for a 1- or 2-week staging)."""
    doctor_id: int
    week: int = Field(ge=1, le=4)
    day: Day
    period: Period


class StagingSessionWriteOut(BaseModel):
    session: StagingSessionOut
    displaced_session: StagingSessionOut | None


class StagingNotePatchIn(BaseModel):
    """PATCH /staging/{staging_id}/notes/{note_id}. A full replace of every
    editable field -- there is no partial update, so an omitted field is a
    422 rather than "leave it alone"."""
    text: str = Field(min_length=1, max_length=200)
    week: int = Field(ge=1, le=4)
    day: Day
    period: Period
    doctor_ids: list[int]

    @field_validator("text")
    @classmethod
    def _strip_text(cls, v: str) -> str:
        stripped = v.strip()
        if not stripped:
            raise ValueError("text must not be empty")
        if len(stripped) > 200:
            raise ValueError("text must be 200 characters or fewer")
        return stripped

    @field_validator("doctor_ids")
    @classmethod
    def _check_doctor_ids(cls, v: list[int]) -> list[int]:
        if not v:
            raise ValueError("doctor_ids must not be empty")
        if len(v) != len(set(v)):
            raise ValueError("doctor_ids must not contain duplicates")
        return v


class StagingNoteIn(StagingNotePatchIn):
    """POST /staging/{staging_id}/notes. One note per call: the frontend
    loops when a tick spans several generation weeks, which keeps this
    endpoint and its validation single-shaped.

    source_note_id is provenance only -- the definition it was copied
    from, so the picker can tick the right box. It is never re-read for
    content, and is NULL for a free-form one-off note."""
    source_note_id: int | None = None


class StagingNoteOut(BaseModel):
    """One per-run note instance. doctor_ids is flattened and sorted
    ascending from the ORM child rows by from_orm_note(), for the same
    reason RecurringNoteOut does it."""
    id: int
    source_note_id: int | None = None
    text: str
    week: int
    day: Day
    period: Period
    doctor_ids: list[int]

    @classmethod
    def from_orm_note(cls, note) -> "StagingNoteOut":
        return cls(
            id=note.id,
            source_note_id=note.source_note_id,
            text=note.text,
            week=note.week,
            day=note.day,
            period=note.period,
            doctor_ids=sorted(d.doctor_id for d in note.doctors),
        )


# StagingOut references StagingNoteOut before it is defined; resolve the
# forward reference now rather than relying on first-validation rebuild.
StagingOut.model_rebuild()
