"""Master rota template schemas (read-only view).

Field naming follows RotaSessionOut/RotaOut's convention, not the plain
`id` used by standalone CRUD entity schemas (DoctorOut, RoomOut, etc.):
these objects sit in a list alongside other `_id` fields (doctor_id,
room_id), so a bare `id` would be ambiguous. See schemas/rota.py.
"""
from pydantic import BaseModel

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