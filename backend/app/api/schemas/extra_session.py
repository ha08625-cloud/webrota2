"""Extra session schemas."""
import datetime

from pydantic import BaseModel

from ...models.enums import ExtraSessionCompensation, Period


class ExtraSessionIn(BaseModel):
    doctor_id: int
    date: datetime.date
    period: Period
    # How the practice compensates this session. Defaulted rather than
    # required so an existing client keeps working and keeps meaning what it
    # meant: Payment is the status quo and the commoner case. Contrast
    # PlanningActionIn.compensation, which is nullable because the planning
    # grid re-emits an action for any cell change and an omitted field there
    # must not silently downgrade a TOIL row.
    compensation: ExtraSessionCompensation = ExtraSessionCompensation.PAYMENT


class ExtraSessionUpdateIn(BaseModel):
    """PATCH body for an existing extra session.

    `compensation` is the only editable field and is required -- a body that
    changes nothing is a client bug here. Date, period and doctor are not the
    same edit; changing one of those is still delete-and-recreate, since it
    moves the row to a different slot with its own uniqueness and validation.
    """

    compensation: ExtraSessionCompensation


class ExtraSessionOut(ExtraSessionIn):
    id: int
    # Annual Planner free-text note (see leave_planning.py); null on every
    # row created outside that grid.
    notes: str | None = None
    model_config = {"from_attributes": True}
