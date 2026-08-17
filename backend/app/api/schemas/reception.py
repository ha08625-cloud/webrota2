"""Reception staff, coverage-rule, weekday master template, and day rota
schemas.

Reception has no cross-entity write logic -- these are plain CRUD shapes,
unlike the nested ClinicType schemas or the displacement-aware master-rota
session schemas. In particular there is no (session_type, room_id)-style
pair validator: a reception hour has no exclusive resource, so role and
note carry no interdependency to enforce (see ReceptionMasterSession's
docstring) -- any role/note combination is legal.
"""
import datetime

from pydantic import BaseModel, Field, field_validator, model_validator

from ...models.enums import Day, ReceptionRole
from ...models.reception import RECEPTION_FIRST_HOUR, RECEPTION_LAST_HOUR
from .common import ValidationIssueOut


def _check_half_hour_step(hour: float) -> float:
    """Field(ge=..., le=...) alone accepts any value in range, e.g. 8.3 --
    this rejects anything that isn't a whole or half hour with a clean 422
    rather than letting it fall through to the DB CheckConstraint (which
    would surface as a 500). Mirrors HOUR_HALF_STEP_SQL in models/reception.py."""
    if (hour * 2) != int(hour * 2):
        raise ValueError("hour must be a whole or half hour (e.g. 9.0 or 9.5)")
    return hour


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
    hour: float
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
    hour: float
    role: ReceptionRole
    note: str | None = None


class ReceptionMasterSessionCreateIn(BaseModel):
    """POST /reception/master/sessions. The full slot coordinates plus the
    (role, note) pair -- PATCH addresses an existing row by id and so only
    needs the pair, but POST has no row yet."""
    staff_id: int
    day: Day
    hour: float = Field(ge=RECEPTION_FIRST_HOUR, le=RECEPTION_LAST_HOUR)
    role: ReceptionRole = ReceptionRole.PHONES
    note: str | None = Field(default=None, max_length=200)

    _check_hour = field_validator("hour")(_check_half_hour_step)


class ReceptionMasterSessionPatchIn(BaseModel):
    """PATCH /reception/master/sessions/{id}. A verbatim (role, note) pair
    setter, not a partial update -- both fields are always required in the
    request body (note may be null), mirroring MasterSessionPatchIn's
    reasoning: undo replay is then just another PATCH with the previous
    pair."""
    role: ReceptionRole
    note: str | None = Field(max_length=200)


class ReceptionRotaGenerateIn(BaseModel):
    """POST /reception/rota. Weekend dates are rejected here (422) before
    the router does anything, mirroring ClosureIn's validator -- generation
    only ever targets a weekday, since the template itself has no
    Saturday/Sunday rows."""
    date: datetime.date

    @model_validator(mode="after")
    def _check_weekday(self) -> "ReceptionRotaGenerateIn":
        if self.date.weekday() > 4:  # Mon=0 ... Fri=4
            raise ValueError("date must be a weekday (Monday-Friday)")
        return self


class ReceptionRotaSessionIn(BaseModel):
    """POST /reception/rota/{id}/sessions: add one staff member to one hour
    of an existing day. Unlike the template's create schema this has no
    `day` -- the day is fixed by the rota it is posted against."""
    staff_id: int
    hour: float = Field(ge=RECEPTION_FIRST_HOUR, le=RECEPTION_LAST_HOUR)
    role: ReceptionRole = ReceptionRole.PHONES
    note: str | None = Field(default=None, max_length=200)

    _check_hour = field_validator("hour")(_check_half_hour_step)


class ReceptionRotaSessionPatchIn(BaseModel):
    """PATCH /reception/rota/{id}/sessions/{sid}. Same verbatim (role, note)
    pair-setter contract as ReceptionMasterSessionPatchIn."""
    role: ReceptionRole
    note: str | None = Field(max_length=200)


class ReceptionRotaSessionOut(BaseModel):
    """One day-rota slot. staff_code / staff_name are joined in the router,
    matching ReceptionMasterSessionOut's pattern."""
    session_id: int
    staff_id: int
    staff_code: str
    staff_name: str
    hour: float
    role: ReceptionRole
    note: str | None = None


class ReceptionRotaOut(BaseModel):
    """GET /reception/rota?date=... and GET /reception/rota/{id}: the day
    header plus its flat session list and freshly computed coverage
    warnings. Also the response of POST /reception/rota (generate)."""
    rota_id: int
    date: datetime.date
    created_at: datetime.datetime
    sessions: list[ReceptionRotaSessionOut]
    issues: list[ValidationIssueOut]
    # Staff with a ReceptionLeaveEntry for this date. Their sessions are
    # still listed above (leave changes nothing about generation or row
    # deletion) but are excluded from the coverage headcount, so the grid
    # needs this to dim their row -- without it the panel would report
    # fewer staff on phones than the user can visibly count.
    staff_on_leave: list[int] = []


class ReceptionSessionWriteOut(BaseModel):
    """Every mutating session endpoint (POST/PATCH) returns the written row
    plus freshly recomputed coverage issues, mirroring SessionPatchOut's
    mutate-then-revalidate contract on the clinical rota.

    Deliberately carries no `staff_on_leave`, unlike ReceptionRotaOut: a
    session write cannot change who is on leave, so the by-date cache's
    existing list stays correct and the frontend has nothing to re-splice.
    """
    session: ReceptionRotaSessionOut
    issues: list[ValidationIssueOut]


# --- Reception leave ---
# Mirrors MAX_BULK_RANGE_DAYS in schemas/leave.py: without it a typo'd end
# year silently inserts tens of thousands of rows.
MAX_RECEPTION_LEAVE_RANGE_DAYS = 366


class ReceptionLeaveIn(BaseModel):
    """POST /reception/leave. Whole days only -- there is no period field
    here or on the model (see ReceptionLeaveEntry's docstring)."""
    staff_id: int
    date: datetime.date


class ReceptionLeaveOut(ReceptionLeaveIn):
    id: int
    model_config = {"from_attributes": True}


class _ReceptionLeaveRangeIn(BaseModel):
    staff_id: int
    start_date: datetime.date
    end_date: datetime.date

    @model_validator(mode="after")
    def _check_range(self) -> "_ReceptionLeaveRangeIn":
        if self.start_date > self.end_date:
            raise ValueError("start_date must not be after end_date")
        if (self.end_date - self.start_date).days > MAX_RECEPTION_LEAVE_RANGE_DAYS:
            raise ValueError(
                f"range must not exceed {MAX_RECEPTION_LEAVE_RANGE_DAYS} days"
            )
        return self


class ReceptionLeaveBulkIn(_ReceptionLeaveRangeIn):
    """POST /reception/leave/bulk."""


class ReceptionLeaveBulkDeleteIn(_ReceptionLeaveRangeIn):
    """POST /reception/leave/bulk-delete."""


class ReceptionLeaveBulkOut(BaseModel):
    """Counts, not the per-date skip list LeaveBulkOut returns. Reception
    leave has no half-days, no employment window and no extra sessions to
    supersede, so the only two things a date can be are "written" and "we
    didn't write it", and three ints say that without the frontend having
    to group and count a list. `skipped_weekend` earns its place because
    reception is Monday-Friday only (the Day enum has no weekend members
    and generation 422s a weekend date) -- a range spanning a fortnight
    quietly writing four rows that can never affect anything would be
    worse than saying so."""
    created: int
    skipped_existing: int
    skipped_weekend: int


class ReceptionLeaveBulkDeleteOut(BaseModel):
    deleted_count: int


# --- Reception role counters ---


class ReceptionCounterRowOut(BaseModel):
    """One staff member's counters over the window (reception counters,
    Task 2). A projection of `StaffRoleCounters` from
    app/reception_counters.py -- the arithmetic lives there, this only
    names the wire shape.

    `role_slots` is a dict keyed by the ReceptionRole values rather than
    thirteen named fields, zero-filled for every role. Adding a role has
    already happened once (migration 004) and must not require a schema
    edit, a frontend type edit and a migration to appear on the page.

    `hours_worked` excludes `not_working` and nothing else, matching the
    exclusion set in compute_role_counters; `role_slots` counts every
    role including `not_working`. The two therefore disagree by design,
    which is why the weighted score for `not_working` is not a proportion
    of anything -- the frontend renders that one cell as an em dash and no
    ratio is computed here or anywhere on the server.
    """
    staff_id: int
    staff_code: str
    staff_name: str
    active: bool
    hours_worked: float
    days_present: int
    role_slots: dict[str, int]


class ReceptionCountersOut(BaseModel):
    """GET /reception/counters. Carries its own window bounds and
    generated-day count, so a reader can interpret the absolute slot counts
    rather than having to reconstruct which dates produced them --
    `days_counted` is the number of distinct generated dates in range, not
    the number of days the range spans."""
    from_date: datetime.date
    to_date: datetime.date
    days_counted: int
    staff: list[ReceptionCounterRowOut]
