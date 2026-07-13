"""ClinicType schemas: full nested create/replace."""
from pydantic import BaseModel, Field, model_validator

from ...models.enums import Day, Period, RoomType


class ScheduleIn(BaseModel):
    day: Day
    period: Period


class DoctorEligIn(BaseModel):
    doctor_id: int
    doctor_priority: int = 1000


class RoomEligIn(BaseModel):
    """Exactly one of room_id / room_type, mirroring the DB check constraint."""
    room_id: int | None = None
    room_type: RoomType | None = None

    @model_validator(mode="after")
    def _exactly_one(self) -> "RoomEligIn":
        if (self.room_id is None) == (self.room_type is None):
            raise ValueError("exactly one of room_id / room_type must be set")
        return self


class ClinicTypeIn(BaseModel):
    name: str = Field(min_length=1)
    is_enabled: bool = True
    room_required: bool = False
    category: str | None = None
    schedules: list[ScheduleIn] = []
    doctor_eligibilities: list[DoctorEligIn] = []
    room_eligibilities: list[RoomEligIn] = []


class ClinicTypeReorderIn(BaseModel):
    """Body for PUT /clinic-types/reorder: the full set of enabled clinic
    type ids in the desired order. The server validates this is exactly the
    current enabled set before applying it -- see the router.
    """
    ordered_ids: list[int]


class ScheduleOut(ScheduleIn):
    id: int
    model_config = {"from_attributes": True}


class DoctorEligOut(DoctorEligIn):
    id: int
    model_config = {"from_attributes": True}


class RoomEligOut(BaseModel):
    id: int
    room_id: int | None = None
    room_type: RoomType | None = None
    model_config = {"from_attributes": True}


class ClinicTypeOut(BaseModel):
    id: int
    name: str
    clinic_priority: int
    is_enabled: bool
    room_required: bool
    category: str | None = None
    schedules: list[ScheduleOut]
    doctor_eligibilities: list[DoctorEligOut]
    room_eligibilities: list[RoomEligOut]
    model_config = {"from_attributes": True}
