"""Rota schemas: generation, retrieval, swaps."""
import datetime
from typing import Literal

from pydantic import BaseModel, Field, model_validator

from ...models.enums import Day, MasterSessionType, Period, RotaStatus, SessionRole
from .closure import ClosedSlotOut
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
    template_type is a snapshot of what the master template said at
    generation time (RotaSession.template_type), so a later template edit
    cannot change it. Generation always sets it; null means it was cleared
    by a set-role write, and renders as a normal session."""
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
    GeneratedRota + its RotaConfig in the router.

    committed_at is null for a draft. The frontend uses it, together with
    the newest-first ordering of this list, to work out which committed
    rota -- if any -- is eligible for the rollback affordance: only the one
    with the latest committed_at among committed rotas.

    archived_at is null unless the rota has been archived; only
    committed rotas can be archived. The frontend uses it to split the
    committed-history list into "Committed" and "Archived" tabs -- purely
    client-side, since this endpoint returns archived rotas unfiltered."""
    rota_id: int
    status: RotaStatus
    created_at: datetime.datetime
    start_date: datetime.date
    num_weeks: int
    template_start_week: int
    committed_at: datetime.datetime | None = None
    archived_at: datetime.datetime | None = None


class RotaOut(BaseModel):
    """GET /rota/{id}: metadata plus the flat session list.

    closed_slots is read from RotaClosure -- the snapshot taken at
    generation time, not the live PracticeClosure table -- so a closure
    added or removed afterwards cannot change what an existing rota reports
    here. Closures are half-day, so a full-day closure appears as two
    entries, one per period. Sorted ascending by (date, period); empty for a
    rota generated with no closures in range.

    committed_at is null for a draft, including one produced by rolling
    back a commit -- see RotaSummaryOut.

    archived_at is null unless the rota has been archived -- see
    RotaSummaryOut. Cleared automatically by rollback-commit.
    """
    rota_id: int
    status: RotaStatus
    created_at: datetime.datetime
    start_date: datetime.date
    num_weeks: int
    template_start_week: int
    sessions: list[RotaSessionOut]
    closed_slots: list[ClosedSlotOut] = Field(default_factory=list)
    committed_at: datetime.datetime | None = None
    archived_at: datetime.datetime | None = None


class SessionPatchIn(BaseModel):
    """Partial update of a draft session. Only fields present
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
    """room_id: null clears the target's room."""
    room_id: int | None = None


class SetRoomOut(BaseModel):
    session: RotaSessionOut
    displaced_session: RotaSessionOut | None
    issues: list[ValidationIssueOut]


class SetRoleIn(BaseModel):
    """Verbatim setter of the full (role, clinic_type_id,
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


class GenerationLogEntryOut(BaseModel):
    """API shape of engine.datatypes.DecisionLogEntry (1:1 fields).

    doctor_id / related_doctor_id / room_id / related_room_id /
    clinic_type_id are plain ids by design -- no joins are done in the
    router. Each row's `message` is already self-contained (built with the
    doctor codes / room codes / clinic names available at generation time),
    and the frontend resolves these ids against its own cached reference
    data, falling back to the raw id (or just the message) for anything
    since deleted. This mirrors RotaGenerationLogEntry's no-FK rationale:
    the log is a diagnostic artifact, not something to join against."""
    sequence: int
    phase: str
    action: str
    week: int | None = None
    day: Day | None = None
    period: Period | None = None
    doctor_id: int | None = None
    related_doctor_id: int | None = None
    room_id: int | None = None
    related_room_id: int | None = None
    clinic_type_id: int | None = None
    message: str
    # The stage-by-stage "why" behind this entry (newline-separated), or
    # null where the decision involved no choice to explain. Prose, not a
    # structure -- the frontend renders it verbatim and never parses it.
    rationale: str | None = None

    model_config = {"from_attributes": True}