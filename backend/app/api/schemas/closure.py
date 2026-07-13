"""Practice closure schemas (M5 bank-holiday weeks)."""
import datetime

from pydantic import BaseModel, model_validator


class ClosureIn(BaseModel):
    date: datetime.date
    name: str | None = None

    @model_validator(mode="after")
    def _check_weekday(self) -> "ClosureIn":
        if self.date.weekday() > 4:  # Mon=0 ... Fri=4
            raise ValueError("date must be a weekday (Monday-Friday)")
        return self


class ClosureOut(ClosureIn):
    id: int
    model_config = {"from_attributes": True}