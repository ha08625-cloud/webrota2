"""Reception staff and coverage-rule schemas (reception rota, Task 2).

Reception has no cross-entity write logic at this task's scope -- these are
plain CRUD shapes, unlike the nested ClinicType schemas or the
displacement-aware master-rota session schemas.
"""
from pydantic import BaseModel, Field

from ...models.enums import Day


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
