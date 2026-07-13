"""Rota schemas: generation, retrieval, swaps."""
import datetime
from typing import Literal

from pydantic import BaseModel, Field, model_validator

from ...models.enums import Day, MasterSessionType, Period, RotaStatus, SessionRole
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
    router; is_on_leave is derived from LeaveEntry (never stored).
    template_type is persisted on the row as of M3.6 (RotaSession.template_type);
    null means either a legacy pre-M3.6 row or a manually-nulled one, and
    renders as a normal session either way."""
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
    template_type: MasterSessionType | None = None
    is_wfh: bool
    is_supervising: bool
    is_on_leave: bool
    notes: str | None = None


class RotaSummaryOut(BaseModel):
    """GET /rota (list): metadata only, no sessions. Joined from
    GeneratedRota + its RotaConfig in the router."""
    rota_id: int
    status: RotaStatus
    created_at: datetime.datetime
    start_date: datetime.date
    num_weeks: int
    template_start_week: int


class RotaOut(BaseModel):
    """GET /rota/{id}: metadata plus the flat session list."""
    rota_id: int
    status: RotaStatus
    created_at: datetime.datetime
    start_date: datetime.date
    num_weeks: int
    template_start_week: int
    sessions: list[RotaSessionOut]


class SessionPatchIn(BaseModel):
    """Partial update of a draft session (M3.5 Task 2). Only fields present
    in the request body are applied (checked via model_fields_set), so
    `notes: null` clears notes while an absent `notes` leaves them alone."""
    is_wfh: bool | None = None
    is_supervising: bool | None = None
    notes: str | None = None


class SessionPatchOut(BaseModel):
    session: RotaSessionOut
    issues: list[ValidationIssueOut]


class SwapIn(BaseModel):
    session_a_id: int
    session_b_id: int


class SwapOut(BaseModel):
    session_a: RotaSessionOut
    session_b: RotaSessionOut
    issues: list[ValidationIssueOut]


class SetRoomIn(BaseModel):
    """M4.1 Task 1. room_id: null clears the target's room."""
    room_id: int | None = None


class SetRoomOut(BaseModel):
    session: RotaSessionOut
    displaced_session: RotaSessionOut | None
    issues: list[ValidationIssueOut]


class SetRoleIn(BaseModel):
    """M4.1 Task 1. Verbatim setter of the full (role, clinic_type_id,
    template_type) triple -- all three fields are required (nullable, but
    must be present) and are written to the target exactly as given. This
    is what makes undo replay able to restore any previous triple,
    including warned states and the full MasterSessionType range, not just
    the two shapes the menu offers directly. The only invariant enforced
    here: clinic_type_id non-null requires role='clinic'."""
    role: SessionRole | None
    clinic_type_id: int | None
    template_type: MasterSessionType | None

    @model_validator(mode="after")
    def _clinic_type_requires_clinic_role(self) -> "SetRoleIn":
        if self.clinic_type_id is not None and self.role != SessionRole.CLINIC:
            raise ValueError("clinic_type_id requires role='clinic'")
        return self


class SetRoleOut(BaseModel):
    session: RotaSessionOut
    displaced_session: RotaSessionOut | None
    issues: list[ValidationIssueOut]