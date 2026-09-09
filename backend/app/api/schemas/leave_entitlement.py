"""Leave entitlement and balance schemas.

Every session figure is a `Decimal` serialised as a JSON string, matching
`DoctorOut.sessions_per_week`'s existing treatment -- these are quantities an
admin reconciles by eye, and a float would render 35.99999999999999 in the
one place that must not happen.
"""
import datetime
from decimal import Decimal

from pydantic import BaseModel, Field, model_validator

from ...models.enums import DoctorType
from .leave import LeaveExemptionsOut

# A guard on the year query parameter, not a business rule: it stops a typo'd
# year from building a date range the rest of the code has to be total over.
MIN_LEAVE_YEAR = 2000
MAX_LEAVE_YEAR = 2100

# Matches LeaveEntitlement.notes' column width.
NOTES_MAX_LENGTH = 200


class LeaveEntitlementIn(BaseModel):
    """Upsert body for one doctor's stored deviations from the rules.

    Every field is optional and omitting all of them stores a row that
    changes nothing -- deliberately allowed, because `notes` alone ("checked
    against payroll, correct") is a legitimate reason to write one.

    `entitlement_sessions` is the *override*, replacing the rule figure
    outright; null (the default) leaves the rules in charge. Setting it to
    the rule's current value is not the same thing as leaving it null: the
    override is frozen, the rule figure follows `sessions_per_week` and the
    employment window.
    """

    entitlement_sessions: Decimal | None = Field(default=None, ge=0, le=9999)
    carry_over_sessions: Decimal = Field(default=Decimal("0.0"), ge=-9999, le=9999)
    adjustment_sessions: Decimal = Field(default=Decimal("0.0"), ge=-9999, le=9999)
    notes: str | None = Field(default=None, max_length=NOTES_MAX_LENGTH)

    @model_validator(mode="after")
    def _check_precision(self) -> "LeaveEntitlementIn":
        for name in (
            "entitlement_sessions",
            "carry_over_sessions",
            "adjustment_sessions",
        ):
            value = getattr(self, name)
            if value is not None and value != value.quantize(Decimal("0.1")):
                raise ValueError(f"{name} must have at most one decimal place")
        return self


class LeaveEntitlementOut(BaseModel):
    """One doctor's entitlement, usage and balance for one leave year.

    Three groups of fields, and the split matters when reading a row:

    - **Entitlement** -- `weeks` x `sessions_per_week` gives
      `full_year_sessions`; times `pro_rata_fraction` gives `rule_sessions`;
      then `override_sessions` (if set) replaces it and carry-over and
      adjustment are added, giving `entitlement_sessions`. Every intermediate
      is returned because a balance nobody can reconstruct is a balance
      nobody trusts.
    - **Usage** -- `used_sessions` is the *chargeable* count from
      `app/leave_charging.py`, not the number of `LeaveEntry` rows.
      `booked_sessions` is that raw row count, and `exempt_by_reason` says
      where the difference went.
    - **The mismatch warning** -- `template_sessions_per_week` and
      `sessions_mismatch`. See `app/leave_entitlement.py`'s module docstring.

    A doctor type with no entitlement (AHP, locum) is not returned by the
    list endpoint at all, so the nullable entitlement fields here are for the
    single-doctor read.
    """

    doctor_id: int
    doctor_code: str
    doctor_type: DoctorType
    year: int
    sessions_per_week: Decimal

    weeks: Decimal | None
    full_year_sessions: Decimal | None
    pro_rata_fraction: Decimal
    rule_sessions: Decimal | None
    override_sessions: Decimal | None
    carry_over_sessions: Decimal
    adjustment_sessions: Decimal
    entitlement_sessions: Decimal | None

    used_sessions: int
    booked_sessions: int
    exempt_by_reason: LeaveExemptionsOut
    remaining_sessions: Decimal | None

    # Working sessions a week implied by the week-1 master template
    # (everything except NO_SURGERY). `sessions_mismatch` is true when it
    # disagrees with `sessions_per_week` *and* the template has been
    # populated at all -- an empty template is reported by
    # `exempt_by_reason.no_template_row` instead, which is the more precise
    # complaint, and the one that must be shown distinctly.
    template_sessions_per_week: int
    sessions_mismatch: bool

    notes: str | None


class LeaveEntitlementYearOut(BaseModel):
    """The whole practice's balances for one year.

    Wrapped rather than a bare list so the year and the range it resolved to
    are on the response: the year is defaulted server-side when the caller
    omits it, and a client that renders "Leave year 2026" needs to be told
    which one it got rather than guessing from its own clock.
    """

    year: int
    from_date: datetime.date
    to_date: datetime.date
    doctors: list[LeaveEntitlementOut]
