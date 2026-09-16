"""Duty schemas."""
import datetime
from decimal import Decimal

from pydantic import BaseModel, Field, model_validator

from ...models.enums import DutyType, Period

# A guard on the year field, not a business rule -- the same range
# `LeaveEntitlement`'s schemas use, for the same reason: it stops a typo'd
# year from creating a row that no duty range will ever resolve to.
MIN_DUTY_YEAR = 2000
MAX_DUTY_YEAR = 2100

# Matches DutyCounterAdjustment.adjustment's Numeric(5,1) column.
_ADJUSTMENT_LIMIT = 9999


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
    """One doctor's duty count over the requested range, plus the
    adjustment the weighted score adds to it.

    `adjustment` is a `Decimal` and so serialises as a JSON string, like
    every other session quantity on this API (`DoctorOut.sessions_per_week`,
    the leave entitlement figures).
    """

    doctor_id: int
    doctor_code: str
    raw_count: int
    adjustment: Decimal


class DutyAdjustmentIn(BaseModel):
    """Upsert body for one doctor's duty counter adjustment in one year.

    Year-scoped because the count it adjusts is: the duty grid reads a whole
    calendar year, and by the next 1 January the count restarts and every
    doctor is genuinely level again.

    `target_count` is a *target effective total* for the year -- "make this
    doctor's duty counter read 14" -- not a credit. The endpoint stores
    `adjustment = target_count - raw_count` against the year's own count; see
    the identical shape in schemas/counter.py for why the derivation is
    server-side and why the field is not just called `count`.

    A target equal to the raw count derives a zero delta, which deletes the
    row rather than storing a zero, so the table holds only real deviations
    (the `LeaveEntitlement` principle).
    """

    doctor_id: int
    year: int = Field(ge=MIN_DUTY_YEAR, le=MAX_DUTY_YEAR)
    target_count: Decimal = Field(ge=-_ADJUSTMENT_LIMIT, le=_ADJUSTMENT_LIMIT)

    @model_validator(mode="after")
    def _one_decimal_place(self) -> "DutyAdjustmentIn":
        """Reject more than one decimal place, then normalise to exactly one --
        see the identical validator in schemas/counter.py."""
        quantized = self.target_count.quantize(Decimal("0.1"))
        if self.target_count != quantized:
            raise ValueError("target_count must have at most one decimal place")
        self.target_count = quantized
        return self