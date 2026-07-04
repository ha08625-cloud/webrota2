"""Duty schemas."""
import datetime

from pydantic import BaseModel

from ...models.enums import DutyType, Period


class DutyIn(BaseModel):
    date: datetime.date
    period: Period
    doctor_id: int
    duty_type: DutyType


class DutyOut(DutyIn):
    id: int
    model_config = {"from_attributes": True}
