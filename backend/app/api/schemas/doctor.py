"""Doctor schemas.

`start_date` / `end_date` are the optional employment window; null at
either end means unbounded. The `start <= end`
check is deliberately NOT a `model_validator` here: a `DoctorPatch` may
supply only one of the pair, so the check needs the merged post-update
values and therefore belongs in the router.
"""
import datetime
from decimal import Decimal

from pydantic import BaseModel, Field, model_validator

from ...models.enums import DoctorType, RoomType, PreferenceWeight


class DoctorIn(BaseModel):
    code: str = Field(min_length=1)
    doctor_type: DoctorType
    sessions_per_week: Decimal = Decimal("10.0")
    supervision_preference: PreferenceWeight = PreferenceWeight.NORMAL
    wfh_preference: PreferenceWeight = PreferenceWeight.NORMAL
    start_date: datetime.date | None = None
    end_date: datetime.date | None = None


class DoctorPatch(BaseModel):
    """Partial update; only supplied fields are applied."""
    code: str | None = Field(default=None, min_length=1)
    doctor_type: DoctorType | None = None
    sessions_per_week: Decimal | None = None
    active: bool | None = None
    supervision_preference: PreferenceWeight | None = None
    wfh_preference: PreferenceWeight | None = None
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

    @model_validator(mode="after")
    def _no_tr(self) -> "PreferredRoomIn":
        """Treatment rooms (TR1-TR3, CK) are nurse rooms no generation
        phase allocates, and a preferred room is the one path by which a
        phase could still seat a doctor in one -- Pass 3 of phase7_9a
        walks the preference list with no room-type filter at all. This
        covers the room_type half only; a room_id pointing at a TR room
        needs the DB to resolve, so the router rejects that half -- see
        doctors._reject_tr_rooms.

        Manual edits and the master rota stay unrestricted: a human
        placing someone in a treatment room is a legitimate override.
        """
        if self.room_type == RoomType.TR:
            raise ValueError(
                "TR is a treatment room and cannot be a preferred room"
            )
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
    supervision_preference: PreferenceWeight
    wfh_preference: PreferenceWeight
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


class DoctorUsageOut(BaseModel):
    """What a permanent delete of one doctor would destroy, read by the
    confirm dialog before it asks. Independent counts rather than a total:
    "4 template slots" and "40 generated sessions" mean very different
    things to the person deciding.

    `committed_rotas` is the count that matters most -- those are rotas
    people have already been given, and the delete rewrites them.
    Deliberately kept off `GET /doctors`, which every section's pickers
    read: these are seven aggregates per doctor, for data that matters on
    one click.
    """
    master_sessions: int
    rota_sessions: int
    committed_rotas: int
    staging_sessions: int
    leave_entries: int
    duty_assignments: int
    extra_sessions: int
    blocked_entries: int


class DoctorDeleteOut(BaseModel):
    """DELETE /doctors/{id}. Rows actually removed, keyed by table name.

    A free-form mapping rather than a field per table: the delete purges
    eighteen tables and derives the counts from
    `routers/_doctors.PURGED_MODELS`, so a table added later is covered by
    editing that one tuple rather than this schema too. Report these in
    preference to the numbers `/usage` returned -- a rota can be generated
    while the confirm dialog is open.

    Tables the delete touched but did not purge are absent: `users` is
    nulled rather than deleted (a login is not history of the doctor), and
    `generated_rotas` headers are left standing even where the purge
    emptied one.
    """
    deleted: dict[str, int]
