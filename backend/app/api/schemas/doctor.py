"""Doctor schemas.

`start_date` / `end_date` are the optional employment window (annual leave
planning, Task 1); null at either end means unbounded. The `start <= end`
check is deliberately NOT a `model_validator` here: a `DoctorPatch` may
supply only one of the pair, so the check needs the merged post-update
values and therefore belongs in the router.
"""
import datetime
from decimal import Decimal

from pydantic import BaseModel, Field, model_validator

from ...models.enums import DoctorType, RoomType, SupervisionPreference


class DoctorIn(BaseModel):
    code: str = Field(min_length=1)
    doctor_type: DoctorType
    sessions_per_week: Decimal = Decimal("10.0")
    supervision_preference: SupervisionPreference = SupervisionPreference.NORMAL
    start_date: datetime.date | None = None
    end_date: datetime.date | None = None


class DoctorPatch(BaseModel):
    """Partial update; only supplied fields are applied."""
    code: str | None = Field(default=None, min_length=1)
    doctor_type: DoctorType | None = None
    sessions_per_week: Decimal | None = None
    active: bool | None = None
    supervision_preference: SupervisionPreference | None = None
    start_date: datetime.date | None = None
    end_date: datetime.date | None = None


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
    supervision_preference: SupervisionPreference
    start_date: datetime.date | None = None
    end_date: datetime.date | None = None
    model_config = {"from_attributes": True}


class DoctorDetailOut(DoctorOut):
    preferred_rooms: list[PreferredRoomOut]

class CalendarFeedOut(BaseModel):
    """One doctor's calendar-feed token and the path that serves it.

    `feed_path` is app-relative (`/api/v1/calendar/<token>.ics`); the
    frontend prepends `window.location.origin`. See
    `app/api/routers/calendar.py:feed_path` for why no absolute URL is
    built server-side.
    """
    doctor_id: int
    token: str
    feed_path: str
