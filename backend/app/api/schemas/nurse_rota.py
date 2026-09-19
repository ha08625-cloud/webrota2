"""Nurse rota schemas.

The nurse rota is a second view over the SAME table the master rota edits
(`master_rota_sessions`), partitioned by `Doctor.doctor_type` rather than
by table. Session rows therefore reuse `MasterRotaSessionOut` verbatim --
same table, same shape, and `doctor_type` is already on it.

What is genuinely new here:

* `NURSE_SESSION_TYPES` -- nurses may only hold three of the five master
  session types. `REQUIRES_ROOM` is a bug state rather than a choice
  (nurses are inert to the engine, so no phase ever rooms one) and `WFH`
  is meaningless for a nurse. The restriction lives on the Pydantic model
  so the rejection is a 422 naming the field, not a hand-rolled 400 in the
  router body. The master rota keeps all five for nurse rows: it is a
  permissive verbatim writer by design.

* `NurseSlotOccupancy` -- one entry per NON-nurse template session holding
  a room. The nurse page holds nurse rows only, so without this the grid
  could not tell which rooms are already taken, and a nurse picking an
  occupied room would get a bare 409 with no way to find a free one. It
  deliberately crosses room occupancy and the holder's code and nothing
  else: no session type, no session id, no name.

* `NurseIn` / `NursePatch` -- the nurse *staff* write bodies. They are new
  types rather than reuses of `DoctorIn`/`DoctorPatch` precisely because of
  what they leave out; see their docstrings. Responses reuse `DoctorOut`,
  which is already this section's shape (the grid reads `doctor_type` off
  it) and carries no `calendar_token`.

Write bodies always carry the full (session_type, room_id) pair rather
than being partial updates, for the same reason MasterSessionPairIn does:
it is what makes the frontend's undo replay expressible as another write
with the previous pair.
"""
import datetime

from pydantic import BaseModel, Field, model_validator

from ...models.enums import Day, MasterSessionType, Period
from .master_rota import MasterRotaSessionOut
from .room import RoomOut

# The three types a nurse row may hold. Enforced server-side rather
# than only hidden from the popover's menu.
NURSE_SESSION_TYPES: set[MasterSessionType] = {
    MasterSessionType.PRE_ASSIGNED,
    MasterSessionType.ADMIN_TIME,
    MasterSessionType.NO_SURGERY,
}

# Same rule as master_rota's pair validator, reduced to the types that
# survive NURSE_SESSION_TYPES: PRE_ASSIGNED needs a room, NO_SURGERY must
# not have one, ADMIN_TIME is in neither set because a roomless admin
# session and a roomed one are both real data.
_ROOM_REQUIRED: set[MasterSessionType] = {MasterSessionType.PRE_ASSIGNED}
_ROOM_FORBIDDEN: set[MasterSessionType] = {MasterSessionType.NO_SURGERY}


class NurseSlotOccupancy(BaseModel):
    """A room held by a non-nurse in one template slot, so the nurse grid
    can grey it out and say who has it."""
    week: int
    day: Day
    period: Period
    room_id: int
    room_code: str
    doctor_code: str


class NurseRotaOut(BaseModel):
    """GET /nurse-rota/active: the active template's nurse rows, the full
    room list, and non-nurse room occupancy.

    Rooms ride along because `GET /rooms` is clinical-gated and a
    nurse_rota-only login cannot reach it; adding a third entry to
    deps._SHARED_READ would be a third hole in default-deny, and one fetch
    for the whole page is the better shape anyway.
    """
    template_id: int
    name: str
    sessions: list[MasterRotaSessionOut]
    rooms: list[RoomOut]
    occupancy: list[NurseSlotOccupancy]


class NurseSessionPairIn(BaseModel):
    """Shared (session_type, room_id) pair validator for PATCH and POST."""
    session_type: MasterSessionType
    room_id: int | None

    @model_validator(mode="after")
    def _check_type_is_a_nurse_type(self) -> "NurseSessionPairIn":
        if self.session_type not in NURSE_SESSION_TYPES:
            raise ValueError(
                f"{self.session_type.value} is not available on the nurse "
                "rota"
            )
        return self

    @model_validator(mode="after")
    def _check_room_matches_type(self) -> "NurseSessionPairIn":
        if self.session_type in _ROOM_REQUIRED and self.room_id is None:
            raise ValueError(f"{self.session_type.value} requires a room_id")
        if self.session_type in _ROOM_FORBIDDEN and self.room_id is not None:
            raise ValueError(
                f"{self.session_type.value} must not have a room_id"
            )
        return self


class NurseSessionPatchIn(NurseSessionPairIn):
    """PATCH /nurse-rota/sessions/{session_id}."""


class NurseSessionCreateIn(NurseSessionPairIn):
    """POST /nurse-rota/sessions.

    Adds the slot coordinates on top of the shared pair validator: PATCH
    addresses an existing row by session_id, POST has no row yet."""
    doctor_id: int
    week: int = Field(ge=1, le=4)
    day: Day
    period: Period


class NurseSessionWriteOut(BaseModel):
    """Shared response shape for PATCH and POST. `displaced_session` is the
    nurse row a write bumped out of a room, or null when nothing moved --
    a non-nurse holder is never displaced, it is a 409 instead."""
    session: MasterRotaSessionOut
    displaced_session: MasterRotaSessionOut | None


class NurseIn(BaseModel):
    """POST /nurse-rota/nurses.

    `doctor_type` is deliberately absent: the router sets it to NURSE
    itself. A payload field would let a nurse_rota-only login mint a
    Partner and inject staff into the clinical rota and the generation
    engine, which is the whole boundary this section rests on.

    `active` is absent too -- the router creates active rows, exactly as
    `create_doctor` does; deactivation is a PATCH. So are
    `sessions_per_week`, `supervision_preference` and `wfh_preference`:
    they take their model defaults, feed engine mechanisms no nurse is ever
    considered by, and `DoctorsPage` already hides all three for nurses.

    Nothing in this codebase sets `extra="forbid"`, so a stray
    `doctor_type` key here is silently ignored rather than rejected. That
    is safe -- an ignored key cannot change the row -- and adding
    `extra="forbid"` on this one model would be a lone deviation from a
    repo-wide convention.
    """
    code: str = Field(min_length=1)
    start_date: datetime.date | None = None
    end_date: datetime.date | None = None


class NursePatch(BaseModel):
    """PATCH /nurse-rota/nurses/{doctor_id}. All fields optional.

    `doctor_type` is absent for the reason it is absent from `NurseIn`, with
    one addition: were it patchable, the 404-unless-nurse guard on this
    endpoint would be worth nothing, because a nurse could be promoted out
    of the partition one request later. A stray `doctor_type` key is
    ignored rather than rejected (see `NurseIn`), so the row's type is
    simply unchanged.

    `active` belongs here and not on `NurseIn`, matching
    `DoctorIn`/`DoctorPatch`: deactivation is an edit of an existing row.
    """
    code: str | None = Field(default=None, min_length=1)
    active: bool | None = None
    start_date: datetime.date | None = None
    end_date: datetime.date | None = None
