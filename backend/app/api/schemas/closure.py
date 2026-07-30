"""Practice closure schemas (M5 bank-holiday weeks, half-day granularity)."""
import datetime

from pydantic import BaseModel, model_validator

from ...models.enums import Period


class ClosureIn(BaseModel):
    date: datetime.date
    period: Period
    name: str | None = None

    @model_validator(mode="after")
    def _check_weekday(self) -> "ClosureIn":
        if self.date.weekday() > 4:  # Mon=0 ... Fri=4
            raise ValueError("date must be a weekday (Monday-Friday)")
        return self


class ClosureOut(ClosureIn):
    id: int
    model_config = {"from_attributes": True}


class ClosedSlotOut(BaseModel):
    date: datetime.date
    period: Period


class BankHolidayOut(BaseModel):
    """One row of the fixed bank-holiday list for a given year: `date` is
    None when no PracticeClosure has been set for that key/year yet."""

    key: str
    name: str
    date: datetime.date | None = None


class BankHolidaySetIn(BaseModel):
    """date=None clears the holiday for that year (deletes its closure)."""

    date: datetime.date | None = None

    @model_validator(mode="after")
    def _check_weekday(self) -> "BankHolidaySetIn":
        if self.date is not None and self.date.weekday() > 4:  # Mon=0 ... Fri=4
            raise ValueError("date must be a weekday (Monday-Friday)")
        return self