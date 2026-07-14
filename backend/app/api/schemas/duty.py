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
    """M5: the day-of-week rule for secondary duty (must land on the
    week's first open weekday, not always Monday) needs PracticeClosure
    data to evaluate, so it can no longer live in a stateless pydantic
    validator here. Pre-M5 this class carried a model_validator enforcing
    "secondary only on a Monday"; that check has moved to
    routers/duty.py's create_duty, which has DB access. See that module's
    docstring for the full rule.
    """


class DutyOut(DutyBase):
    id: int
    model_config = {"from_attributes": True}

class DutyCountOut(BaseModel):
    doctor_id: int
    doctor_code: str
    raw_count: int