"""Duty schemas."""
import datetime
from decimal import Decimal

from pydantic import BaseModel, Field, model_validator

from ...models.duty_opening_balance import NOTES_MAX_LENGTH
from ...models.enums import DutyType, Period

# A guard on the year field, not a business rule -- the same range
# `LeaveEntitlement`'s schemas use, for the same reason: it stops a typo'd
# year from creating a row that no duty range will ever resolve to.
MIN_DUTY_YEAR = 2000
MAX_DUTY_YEAR = 2100

# Matches DutyOpeningBalance.sessions' Numeric(5,1) column.
_BALANCE_LIMIT = 9999


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
    """One doctor's duty count over the requested range, plus the opening
    balance the weighted score adds to it.

    `opening_balance` is a `Decimal` and so serialises as a JSON string, like
    every other session quantity on this API (`DoctorOut.sessions_per_week`,
    the leave entitlement figures).
    """

    doctor_id: int
    doctor_code: str
    raw_count: int
    opening_balance: Decimal


class DutyOpeningBalanceIn(BaseModel):
    """Upsert body for one doctor's duty opening balance in one year.

    Year-scoped because the count it adjusts is: the duty grid reads a whole
    calendar year, and by the next 1 January the count restarts and every
    doctor is genuinely level again.

    Setting `sessions` to zero deletes the row rather than storing a zero, so
    the table holds only real deviations (the `LeaveEntitlement` principle) --
    which means `notes` are deleted with it. Notes describe why a credit
    exists, so there is nothing for them to describe once it does not.
    """

    doctor_id: int
    year: int = Field(ge=MIN_DUTY_YEAR, le=MAX_DUTY_YEAR)
    sessions: Decimal = Field(ge=-_BALANCE_LIMIT, le=_BALANCE_LIMIT)
    notes: str | None = Field(default=None, max_length=NOTES_MAX_LENGTH)

    @model_validator(mode="after")
    def _one_decimal_place(self) -> "DutyOpeningBalanceIn":
        """Reject more than one decimal place, then normalise to exactly one --
        see the identical validator in schemas/counter.py."""
        quantized = self.sessions.quantize(Decimal("0.1"))
        if self.sessions != quantized:
            raise ValueError("sessions must have at most one decimal place")
        self.sessions = quantized
        return self