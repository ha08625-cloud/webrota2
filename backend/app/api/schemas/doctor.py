"""Doctor schemas."""
from decimal import Decimal

from pydantic import BaseModel, Field, model_validator

from ...models.enums import DoctorType, RoomType


class DoctorIn(BaseModel):
    code: str = Field(min_length=1)
    doctor_type: DoctorType
    sessions_per_week: Decimal = Decimal("10.0")


class DoctorPatch(BaseModel):
    """Partial update; only supplied fields are applied."""
    code: str | None = Field(default=None, min_length=1)
    doctor_type: DoctorType | None = None
    sessions_per_week: Decimal | None = None
    active: bool | None = None


class PreferredRoomIn(BaseModel):
    """Exactly one of room_id / room_type, mirroring the DB check constraint."""
    preference_order: int = Field(ge=1)
    room_id: int | None = None
    room_type: RoomType | None = None

    @model_validator(mode="after")
    def _exactly_one(self) -> "PreferredRoomIn":
        if (self.room_id is None) == (self.room_type is None):
            raise ValueError("exactly one of room_id / room_type must be set")
        return self


class PreferredRoomOut(BaseModel):
    id: int
    preference_order: int
    room_id: int | None = None
    room_type: RoomType | None = None
    model_config = {"from_attributes": True}


class DoctorOut(BaseModel):
    id: int
    code: str
    doctor_type: DoctorType
    sessions_per_week: Decimal
    active: bool
    model_config = {"from_attributes": True}


class DoctorDetailOut(DoctorOut):
    preferred_rooms: list[PreferredRoomOut]
