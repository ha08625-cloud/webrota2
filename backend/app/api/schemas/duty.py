"""Duty schemas."""
import datetime

from pydantic import BaseModel

from ...models.enums import DutyType, Period


class DutyBase(BaseModel):
    date: datetime.date
    period: Period
    doctor_id: int
    duty_type: DutyType


class DutyIn(DutyBase):
    """Create body -- the same fields as DutyBase, with no validation of
    its own.

    The day-of-week rule for secondary duty (it must land on the week's
    first *fully open* weekday -- neither AM nor PM closed -- which is only
    Monday when nothing is closed) needs PracticeClosure data, so it cannot
    be a stateless pydantic validator. It lives in routers/duty.py's
    create_duty, alongside the two other DB-dependent checks; see that
    module's docstring.
    """


class DutyOut(DutyBase):
    id: int
    model_config = {"from_attributes": True}

class DutyCountOut(BaseModel):
    doctor_id: int
    doctor_code: str
    raw_count: int