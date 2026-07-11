"""Master rota template schemas.

Field naming follows RotaSessionOut/RotaOut's convention, not the plain
`id` used by standalone CRUD entity schemas (DoctorOut, RoomOut, etc.):
these objects sit in a list alongside other `_id` fields (doctor_id,
room_id), so a bare `id` would be ambiguous. See schemas/rota.py.

MasterSessionPatchIn/Out (M4.3 Task 1) add the single-session edit path
on top of the original read-only GET. Both fields on the patch are
always required, mirroring SetRoleIn's verbatim-triple philosophy: the
endpoint is a plain pair setter, which is what makes undo replay on the
frontend trivially expressible as another PATCH with the previous pair.
"""
from pydantic import BaseModel, model_validator

from ...models.enums import Day, DoctorType, MasterSessionType, Period


class MasterRotaSessionOut(BaseModel):
    """One master template slot. doctor_code / room_code are joined in
    the router, matching the pattern in routers/rota.py's _session_outs.

    doctor_type is joined the same way (added alongside doctor_code, not
    just code) so the frontend can group grid rows by doctor type
    (Partner/Salaried/Trainee/AHP) without a separate /doctors fetch."""
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


class MasterRotaTemplateOut(BaseModel):
    """GET /master-rota/active: the single active template with its
    flat session list."""
    template_id: int
    name: str
    sessions: list[MasterRotaSessionOut]


# room_id requirement per session_type, matching what phase2._build_grid
# actually does with each MasterSessionType (see phase2._PRE_OCCUPYING_TYPES
# and the REQUIRES_ROOM/NO_SURGERY/WFH branches):
#   PRE_ASSIGNED           -- room_id required (non-null)
#   ADMIN_TIME             -- room_id optional (both seeded and roomless
#                              ADMIN_TIME are real data)
#   REQUIRES_ROOM/NO_SURGERY/WFH -- room_id must be null
_ROOM_REQUIRED: set[MasterSessionType] = {MasterSessionType.PRE_ASSIGNED}
_ROOM_OPTIONAL: set[MasterSessionType] = {MasterSessionType.ADMIN_TIME}
_ROOM_FORBIDDEN: set[MasterSessionType] = {
    MasterSessionType.REQUIRES_ROOM,
    MasterSessionType.NO_SURGERY,
    MasterSessionType.WFH,
}


class MasterSessionPatchIn(BaseModel):
    """PATCH /master-rota/templates/{template_id}/sessions/{session_id}.

    Both fields are always present -- a verbatim pair setter, not a partial
    update -- so the frontend's undo replay can restore any previous
    (session_type, room_id) pair with the same call shape the menu uses.
    """
    session_type: MasterSessionType
    room_id: int | None

    @model_validator(mode="after")
    def _check_room_matches_type(self) -> "MasterSessionPatchIn":
        if self.session_type in _ROOM_REQUIRED and self.room_id is None:
            raise ValueError(
                f"{self.session_type.value} requires a room_id"
            )
        if self.session_type in _ROOM_FORBIDDEN and self.room_id is not None:
            raise ValueError(
                f"{self.session_type.value} must not have a room_id"
            )
        return self


class MasterSessionPatchOut(BaseModel):
    session: MasterRotaSessionOut
    displaced_session: MasterRotaSessionOut | None