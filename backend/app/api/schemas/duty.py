"""Duty schemas."""
import datetime

from pydantic import BaseModel, model_validator

from ...models.enums import DutyType, Period


class DutyBase(BaseModel):
    date: datetime.date
    period: Period
    doctor_id: int
    duty_type: DutyType


class DutyIn(DutyBase):
    @model_validator(mode="after")
    def _validate_secondary_monday(self) -> "DutyIn":
        if self.duty_type == DutyType.SECONDARY and self.date.weekday() != 0:
            raise ValueError("Secondary duty can only be assigned on a Monday")
        return self


class DutyOut(DutyBase):
    id: int
    model_config = {"from_attributes": True}