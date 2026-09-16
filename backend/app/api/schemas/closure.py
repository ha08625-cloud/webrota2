"""Practice closure schemas. Closures are per (date, period), so a full-day
closure is two rows."""
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
    """`bank_holiday_key` is set only on the rows the Bank Holidays UI owns
    (models/closure.py), so a client can tell those apart from ad-hoc
    closures without matching on the editable free-text `name`."""

    id: int
    bank_holiday_key: str | None = None
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