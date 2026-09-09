"""Leave schemas."""
import datetime
from typing import Literal

from pydantic import BaseModel, model_validator

from ...models.enums import Period
from .extra_session import ExtraSessionOut

MAX_BULK_RANGE_DAYS = 366


class LeaveIn(BaseModel):
    doctor_id: int
    date: datetime.date
    period: Period


class LeaveOut(LeaveIn):
    id: int
    # Annual Planner free-text note (see leave_planning.py); null on every
    # row created outside that grid.
    notes: str | None = None
    model_config = {"from_attributes": True}


class LeaveBulkIn(BaseModel):
    doctor_id: int
    start_date: datetime.date
    end_date: datetime.date
    period: Period | Literal["BOTH"]

    @model_validator(mode="after")
    def _check_range(self) -> "LeaveBulkIn":
        if self.start_date > self.end_date:
            raise ValueError("start_date must not be after end_date")
        if (self.end_date - self.start_date).days > MAX_BULK_RANGE_DAYS:
            raise ValueError(f"range must not exceed {MAX_BULK_RANGE_DAYS} days")
        return self


class LeaveBulkSkippedOut(BaseModel):
    date: datetime.date
    period: Period
    # "outside_doctor_dates" is the employment-window skip. Bulk reports it
    # rather than 422ing the whole call, unlike the single-entry POST -- one
    # stale date must not fail a many-date save.
    reason: Literal["weekend", "duplicate", "outside_doctor_dates"]


class LeaveBulkOut(BaseModel):
    created: list[LeaveOut]
    skipped: list[LeaveBulkSkippedOut]
    superseded_extra_sessions: list[ExtraSessionOut]


class LeaveBulkDeleteIn(BaseModel):
    doctor_id: int
    start_date: datetime.date
    end_date: datetime.date
    period: Period | Literal["BOTH"]

    @model_validator(mode="after")
    def _check_range(self) -> "LeaveBulkDeleteIn":
        if self.start_date > self.end_date:
            raise ValueError("start_date must not be after end_date")
        return self


class LeaveBulkDeleteOut(BaseModel):
    deleted_count: int


class LeaveExemptionsOut(BaseModel):
    """Exempt-session breakdown for `GET /leave/chargeable-count`.

    Field order here is *display* order, not computation order: the rule
    checks closure **last**, after weekend / no-template-row / no-surgery,
    so that `closed` means "the doctor would otherwise have worked this
    slot, but the practice was shut" rather than merely "this slot fell on
    a closure". Reordering these fields to match computation order would
    silently destroy that distinction -- don't.
    """

    closed: int
    weekend: int
    no_template_row: int
    no_surgery: int


class LeaveChargeableCountOut(BaseModel):
    doctor_id: int
    from_date: datetime.date
    to_date: datetime.date
    total_entries: int
    # Counts are in sessions (one LeaveEntry row = one half-day), not days
    # -- the `_sessions` suffixes are load-bearing.
    chargeable_sessions: int
    exempt_sessions: int
    exempt_by_reason: LeaveExemptionsOut