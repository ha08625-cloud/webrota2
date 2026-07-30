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
    # "outside_doctor_dates" is the employment-window skip (annual leave
    # planning, Task 1). Bulk reports it rather than 422ing the whole call,
    # unlike the single-entry POST -- one stale date must not fail a
    # many-date save.
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