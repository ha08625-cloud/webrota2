"""Leave entitlement rules (leave entitlement and balances plan).

Pure logic shared by nothing else yet, kept out of the router for the same
reason `leave_charging.py` is: the rules carry the design decisions and are
worth unit-testing without a `TestClient`. Top-level under `app/` alongside
`leave_charging.py`, which it is the other half of -- that module counts what
a doctor has *used*, this one says what they were *entitled to*. Nothing
under `engine/` imports either.

The rules, in the practice's own terms:

- A **partner** gets 7 weeks of leave a year; a **salaried** or **trainee**
  doctor gets 6. **AHPs and locums get none** -- AHP leave is assigned by a
  third party, and locums are engaged per session.
- Leave is counted in **sessions** (one session = one AM or PM half day),
  never in days, so a week of leave is worth the doctor's own
  `sessions_per_week`. Six weeks for a six-session doctor is 36 sessions.
- The leave year is **1 January to 31 December**.
- A doctor employed for only part of the year is **pro-rated by days
  employed** against `Doctor.start_date` / `Doctor.end_date`.

## The unit mismatch this module deliberately exposes

Entitlement is credited in `Doctor.sessions_per_week`, but leave is *charged*
against the master template: `leave_charging.exemption_reason` counts a booked
slot only when the doctor has a week-1 template row for it that is not
`NO_SURGERY` (`ADMIN_TIME` and `WFH` are working sessions and are charged).
Those two figures need not agree, and when they don't a doctor burns their
allowance at a different rate from the one it accrues at -- credited in one
unit, charged in another. That was flagged as an open question by the
no-surgery exemption plan (its Design Decision 7.2) and is resolved here by
**keeping `sessions_per_week` authoritative for entitlement and reporting the
disagreement** rather than silently picking a side: `template_sessions_per_week`
is returned alongside every balance so the UI can surface it. Making the
template authoritative was rejected because a doctor whose template has not
been populated yet would read zero entitlement, which is worse than reading a
warning.
"""
from __future__ import annotations

import calendar
import datetime
from collections.abc import Mapping
from dataclasses import dataclass
from decimal import ROUND_HALF_UP, Decimal

from .models.enums import Day, DoctorType, MasterSessionType, Period

# Weeks of leave per doctor type. A type absent from this map has no
# entitlement at all -- AHPs (assigned by a third party) and locums (engaged
# per session). Absence rather than a zero value so "has an entitlement" is a
# membership test and a new doctor type has to be considered explicitly
# rather than defaulting to zero weeks.
LEAVE_WEEKS_BY_DOCTOR_TYPE: dict[DoctorType, Decimal] = {
    DoctorType.PARTNER: Decimal("7"),
    DoctorType.SALARIED: Decimal("6"),
    DoctorType.TRAINEE: Decimal("6"),
}

# Sessions are quantised to one decimal place, matching
# `LeaveEntitlement.entitlement_sessions` (Numeric(5,1)) and
# `Doctor.sessions_per_week` (Numeric(4,1)). Only pro-rating produces a
# fraction at all: a full year is always an exact multiple of the doctor's
# weekly sessions.
SESSION_QUANTUM = Decimal("0.1")


def quantise_sessions(value: Decimal) -> Decimal:
    """Round a session count to the stored precision, half away from zero."""
    return value.quantize(SESSION_QUANTUM, rounding=ROUND_HALF_UP)


def year_bounds(year: int) -> tuple[datetime.date, datetime.date]:
    """The leave year: 1 January to 31 December, both inclusive."""
    return datetime.date(year, 1, 1), datetime.date(year, 12, 31)


def days_in_year(year: int) -> int:
    return 366 if calendar.isleap(year) else 365


def employed_days_in_year(
    start_date: datetime.date | None,
    end_date: datetime.date | None,
    year: int,
) -> int:
    """Days of `year` inside the doctor's employment window, both ends
    inclusive.

    A null bound is unbounded, which is the default for every doctor that
    predates the employment-window feature -- so the common case returns a
    full year. A window that misses the year entirely returns 0, and a
    reversed window (end before start, representable because the ordering is
    validated at the API boundary rather than by a constraint) also returns 0
    rather than a negative count.
    """
    jan, dec = year_bounds(year)
    first = max(start_date, jan) if start_date is not None else jan
    last = min(end_date, dec) if end_date is not None else dec
    if first > last:
        return 0
    return (last - first).days + 1


def pro_rata_fraction(
    start_date: datetime.date | None,
    end_date: datetime.date | None,
    year: int,
) -> Decimal:
    """Fraction of `year` the doctor was employed for, 0 to 1.

    Days, not weeks or months: a day count needs no decision about what to do
    with a doctor who starts mid-week or mid-month, and 2 January to 31
    December is not a full year's leave under any honest reading.
    """
    return Decimal(employed_days_in_year(start_date, end_date, year)) / Decimal(
        days_in_year(year)
    )


def rule_entitlement_sessions(
    doctor_type: DoctorType,
    sessions_per_week: Decimal,
    start_date: datetime.date | None,
    end_date: datetime.date | None,
    year: int,
) -> Decimal | None:
    """The entitlement the rules give this doctor for `year`, in sessions.

    `None` -- not zero -- for a doctor type with no entitlement, so a caller
    can tell "not entitled to leave" (an AHP, whose leave is somebody else's
    business) apart from "entitled to nothing this year" (a doctor who left
    in December of the previous year). The UI shows those two very
    differently.
    """
    weeks = LEAVE_WEEKS_BY_DOCTOR_TYPE.get(doctor_type)
    if weeks is None:
        return None
    full_year = weeks * Decimal(sessions_per_week)
    return quantise_sessions(full_year * pro_rata_fraction(start_date, end_date, year))


def template_sessions_per_week(
    doctor_id: int,
    template: Mapping[tuple[int, Day, Period], MasterSessionType],
) -> int:
    """Working sessions a week implied by the doctor's week-1 template.

    "Working" here is exactly `leave_charging`'s definition and must stay
    that way: every session type except `NO_SURGERY` counts, `ADMIN_TIME` and
    `WFH` included. This is the denominator leave is actually *charged* in,
    returned so the disagreement with `sessions_per_week` can be surfaced
    rather than discovered from a balance that drifts (see the module
    docstring).

    A doctor with no template rows returns 0, which means "the template has
    not been populated", not "this doctor works nothing" -- the same
    ambiguity `leave_charging`'s `no_template_row` bucket exists to flag.
    """
    return sum(
        1
        for (row_doctor_id, _day, _period), session_type in template.items()
        if row_doctor_id == doctor_id and session_type is not MasterSessionType.NO_SURGERY
    )


@dataclass(frozen=True)
class EntitlementBreakdown:
    """One doctor's entitlement for one year, before any leave is counted.

    `total` is what a balance is measured against: the override if there is
    one, otherwise the rule figure, plus carry-over and adjustment either
    way. `None` throughout for a doctor type with no entitlement.
    """

    weeks: Decimal | None
    full_year_sessions: Decimal | None
    pro_rata_fraction: Decimal
    rule_sessions: Decimal | None
    override_sessions: Decimal | None
    carry_over_sessions: Decimal
    adjustment_sessions: Decimal
    total_sessions: Decimal | None


def build_entitlement(
    doctor_type: DoctorType,
    sessions_per_week: Decimal,
    start_date: datetime.date | None,
    end_date: datetime.date | None,
    year: int,
    override_sessions: Decimal | None = None,
    carry_over_sessions: Decimal = Decimal("0.0"),
    adjustment_sessions: Decimal = Decimal("0.0"),
) -> EntitlementBreakdown:
    """Combine the rules with a stored `LeaveEntitlement` row's deviations.

    The stored columns are passed in individually rather than as the model,
    so this stays testable with no DB and a doctor with no row is just the
    default arguments.

    A doctor type with no entitlement ignores any stored row entirely: an
    override on an AHP is meaningless, and honouring it would put a balance
    on a doctor the practice does not track leave for. Such a row is
    rejected at the API boundary, so this is belt and braces.
    """
    weeks = LEAVE_WEEKS_BY_DOCTOR_TYPE.get(doctor_type)
    fraction = pro_rata_fraction(start_date, end_date, year)
    if weeks is None:
        return EntitlementBreakdown(
            weeks=None,
            full_year_sessions=None,
            pro_rata_fraction=fraction,
            rule_sessions=None,
            override_sessions=None,
            carry_over_sessions=Decimal("0.0"),
            adjustment_sessions=Decimal("0.0"),
            total_sessions=None,
        )

    full_year = quantise_sessions(weeks * Decimal(sessions_per_week))
    rule = quantise_sessions(Decimal(full_year) * fraction)
    base = rule if override_sessions is None else Decimal(override_sessions)
    total = quantise_sessions(
        base + Decimal(carry_over_sessions) + Decimal(adjustment_sessions)
    )
    return EntitlementBreakdown(
        weeks=weeks,
        full_year_sessions=full_year,
        pro_rata_fraction=fraction,
        rule_sessions=rule,
        override_sessions=(
            None if override_sessions is None else Decimal(override_sessions)
        ),
        carry_over_sessions=Decimal(carry_over_sessions),
        adjustment_sessions=Decimal(adjustment_sessions),
        total_sessions=total,
    )
