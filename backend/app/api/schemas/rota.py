"""Rota schemas: generation, retrieval, swaps."""
import datetime
from typing import Literal

from pydantic import BaseModel, Field

from ...models.enums import Day, Period, RotaStatus, SessionRole
from .common import ValidationIssueOut


class GenerateRotaIn(BaseModel):
    start_date: datetime.date
    num_weeks: Literal[1, 2, 4]
    template_start_week: int = Field(default=1, ge=1, le=4)


class GenerateRotaOut(BaseModel):
    rota_id: int
    status: RotaStatus
    issues: list[ValidationIssueOut]


class RotaSessionOut(BaseModel):
    """One generated session. room_code / clinic_type_name are joined in the
    router; is_on_leave is derived from LeaveEntry (never stored)."""
    session_id: int
    doctor_id: int
    doctor_code: str
    week: int
    day: Day
    period: Period
    room_id: int | None = None
    room_code: str | None = None
    clinic_type_id: int | None = None
    clinic_type_name: str | None = None
    role: SessionRole | None = None
    is_wfh: bool
    is_on_leave: bool
    notes: str | None = None


class RotaOut(BaseModel):
    """GET /rota/{id}: metadata plus the flat session list."""
    rota_id: int
    status: RotaStatus
    created_at: datetime.datetime
    start_date: datetime.date
    num_weeks: int
    template_start_week: int
    sessions: list[RotaSessionOut]


class SwapIn(BaseModel):
    session_a_id: int
    session_b_id: int


class SwapOut(BaseModel):
    session_a: RotaSessionOut
    session_b: RotaSessionOut
    issues: list[ValidationIssueOut]
