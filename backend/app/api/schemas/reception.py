"""Reception staff, coverage-rule, and weekday master template schemas.

Reception has no cross-entity write logic -- these are plain CRUD shapes,
unlike the nested ClinicType schemas or the displacement-aware master-rota
session schemas. In particular there is no (session_type, room_id)-style
pair validator: a reception hour has no exclusive resource, so role and
note carry no interdependency to enforce (see ReceptionMasterSession's
docstring) -- any role/note combination is legal.
"""
from pydantic import BaseModel, Field

from ...models.enums import Day, ReceptionRole
from ...models.reception import RECEPTION_FIRST_HOUR, RECEPTION_LAST_HOUR


class ReceptionStaffIn(BaseModel):
    code: str = Field(min_length=1)
    name: str = Field(min_length=1)


class ReceptionStaffPatch(BaseModel):
    """Partial update; only fields present in the request body are applied
    (checked via model_fields_set), matching SessionPatchIn's convention."""
    code: str | None = Field(default=None, min_length=1)
    name: str | None = Field(default=None, min_length=1)
    active: bool | None = None


class ReceptionStaffOut(BaseModel):
    id: int
    code: str
    name: str
    active: bool
    model_config = {"from_attributes": True}


class CoverageRulePatch(BaseModel):
    """The only editable field on a coverage rule -- see the router: no POST
    or DELETE exists because the (day, hour) row set is fixed by the seed."""
    min_phones_staff: int = Field(ge=0)


class CoverageRuleOut(BaseModel):
    id: int
    day: Day
    hour: int
    min_phones_staff: int
    model_config = {"from_attributes": True}


class ReceptionMasterSessionOut(BaseModel):
    """One weekday template slot. staff_code / staff_name are joined in the
    router, matching MasterRotaSessionOut's pattern. `session_id`, not `id`
    -- this sits in a list alongside staff_id, the same naming rule
    MasterRotaSessionOut documents."""
    session_id: int
    staff_id: int
    staff_code: str
    staff_name: str
    day: Day
    hour: int
    role: ReceptionRole
    note: str | None = None


class ReceptionMasterSessionCreateIn(BaseModel):
    """POST /reception/master/sessions. The full slot coordinates plus the
    (role, note) pair -- PATCH addresses an existing row by id and so only
    needs the pair, but POST has no row yet."""
    staff_id: int
    day: Day
    hour: int = Field(ge=RECEPTION_FIRST_HOUR, le=RECEPTION_LAST_HOUR)
    role: ReceptionRole = ReceptionRole.PHONES
    note: str | None = Field(default=None, max_length=200)


class ReceptionMasterSessionPatchIn(BaseModel):
    """PATCH /reception/master/sessions/{id}. A verbatim (role, note) pair
    setter, not a partial update -- both fields are always required in the
    request body (note may be null), mirroring MasterSessionPatchIn's
    reasoning: undo replay is then just another PATCH with the previous
    pair."""
    role: ReceptionRole
    note: str | None = Field(max_length=200)
