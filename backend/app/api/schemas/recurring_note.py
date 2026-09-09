"""RecurringNote schemas -- the *definition* library.

A definition schedules nothing: day, period and the doctor list are the
defaults a pick copies onto a per-run instance (StagingNoteIn /
StagingNoteOut in schemas/staging.py). There are no template weeks --
the week a note lands on is chosen per run on the staging page, so it is
a property of the instance, not of the definition.

RecurringNoteIn takes doctor_ids as a plain int list rather than a
nested child schema (contrast ClinicTypeIn's ScheduleIn / DoctorEligIn):
there is nothing per-association worth carrying -- no priority, no room
type -- so a bare list keeps the payload and the router's
replace-children step simple.

RecurringNoteOut cannot be built by plain from_attributes ORM mapping:
the model's relationship is named `doctors` (a list of child rows), not
the flat `doctor_ids` this schema exposes, and the API contract sorts it
ascending regardless of DB insertion order. from_orm_note() does that
mapping explicitly; the router uses it instead of returning the ORM
object straight through response_model.
"""
from pydantic import BaseModel, Field, field_validator

from ...models.enums import Day, Period


class RecurringNoteIn(BaseModel):
    text: str = Field(min_length=1, max_length=200)
    day: Day
    period: Period
    is_active: bool = True
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


class RecurringNoteOut(BaseModel):
    id: int
    text: str
    day: Day
    period: Period
    is_active: bool
    doctor_ids: list[int]
    model_config = {"from_attributes": True}

    @classmethod
    def from_orm_note(cls, note) -> "RecurringNoteOut":
        return cls(
            id=note.id,
            text=note.text,
            day=note.day,
            period=note.period,
            is_active=note.is_active,
            doctor_ids=sorted(d.doctor_id for d in note.doctors),
        )
