"""Unit tests for the leave entitlement rules (leave entitlement and
balances plan).

Pure functions over plain values -- no DB, no TestClient. The endpoint's own
tests cover wiring and only spot-check the arithmetic.

2026 is a common year (365 days) and 2028 is a leap year (366); both appear
here because the pro-rata denominator differs between them.
"""
import datetime
from decimal import Decimal

import pytest

from app.leave_entitlement import (
    LEAVE_WEEKS_BY_DOCTOR_TYPE,
    build_entitlement,
    days_in_year,
    employed_days_in_year,
    pro_rata_fraction,
    rule_entitlement_sessions,
    template_sessions_per_week,
    year_bounds,
)
from app.models.enums import Day, DoctorType, MasterSessionType, Period

D = Decimal


# --- The weeks table -------------------------------------------------------

def test_partners_get_seven_weeks():
    assert LEAVE_WEEKS_BY_DOCTOR_TYPE[DoctorType.PARTNER] == D("7")


def test_salaried_and_trainees_get_six_weeks():
    assert LEAVE_WEEKS_BY_DOCTOR_TYPE[DoctorType.SALARIED] == D("6")
    assert LEAVE_WEEKS_BY_DOCTOR_TYPE[DoctorType.TRAINEE] == D("6")


@pytest.mark.parametrize("doctor_type", [DoctorType.AHP, DoctorType.LOCUM])
def test_ahps_and_locums_have_no_entitlement(doctor_type):
    """Absent from the map, not zero -- "not entitled to leave" and
    "entitled to nothing this year" are different facts and the UI shows
    them differently."""
    assert doctor_type not in LEAVE_WEEKS_BY_DOCTOR_TYPE
    assert rule_entitlement_sessions(doctor_type, D("10"), None, None, 2026) is None


# --- The leave year --------------------------------------------------------

def test_year_runs_january_to_december():
    assert year_bounds(2026) == (datetime.date(2026, 1, 1), datetime.date(2026, 12, 31))


def test_days_in_year_handles_leap_years():
    assert days_in_year(2026) == 365
    assert days_in_year(2028) == 366


# --- Employment window / pro-rata -----------------------------------------

def test_unbounded_window_is_the_whole_year():
    assert employed_days_in_year(None, None, 2026) == 365
    assert pro_rata_fraction(None, None, 2026) == D("1")


def test_window_wholly_containing_the_year_is_the_whole_year():
    assert (
        employed_days_in_year(
            datetime.date(2020, 1, 1), datetime.date(2030, 1, 1), 2026
        )
        == 365
    )


def test_start_mid_year_is_clipped_to_the_year():
    """1 July 2026 to 31 December is 184 days of 365."""
    assert employed_days_in_year(datetime.date(2026, 7, 1), None, 2026) == 184


def test_end_mid_year_is_clipped_to_the_year():
    """1 January to 30 June 2026 is 181 days."""
    assert employed_days_in_year(None, datetime.date(2026, 6, 30), 2026) == 181


def test_both_ends_inclusive():
    """A one-day window counts as one day, not zero."""
    day = datetime.date(2026, 3, 4)
    assert employed_days_in_year(day, day, 2026) == 1


def test_window_entirely_before_the_year_is_zero():
    assert employed_days_in_year(None, datetime.date(2025, 12, 31), 2026) == 0


def test_window_entirely_after_the_year_is_zero():
    assert employed_days_in_year(datetime.date(2027, 1, 1), None, 2026) == 0


def test_reversed_window_is_zero_not_negative():
    """The start/end ordering is validated at the API boundary rather than
    by a constraint, so a reversed pair is representable and must not
    produce a negative day count."""
    assert (
        employed_days_in_year(
            datetime.date(2026, 9, 1), datetime.date(2026, 3, 1), 2026
        )
        == 0
    )


# --- The rule figure -------------------------------------------------------

def test_six_sessions_a_week_salaried_is_thirty_six():
    """The practice's own worked example: 6 weeks x 6 sessions."""
    assert rule_entitlement_sessions(
        DoctorType.SALARIED, D("6"), None, None, 2026
    ) == D("36.0")


def test_ten_session_partner_is_seventy():
    assert rule_entitlement_sessions(
        DoctorType.PARTNER, D("10"), None, None, 2026
    ) == D("70.0")


def test_trainee_uses_the_six_week_figure():
    assert rule_entitlement_sessions(
        DoctorType.TRAINEE, D("8"), None, None, 2026
    ) == D("48.0")


def test_half_sessions_per_week_are_carried_through():
    """sessions_per_week is Numeric(4,1), so 7.5 is representable."""
    assert rule_entitlement_sessions(
        DoctorType.SALARIED, D("7.5"), None, None, 2026
    ) == D("45.0")


def test_part_year_is_pro_rated_by_days():
    """A salaried 6-session doctor starting 1 July 2026: 36 x 184/365."""
    assert rule_entitlement_sessions(
        DoctorType.SALARIED, D("6"), datetime.date(2026, 7, 1), None, 2026
    ) == D("18.1")


def test_leap_year_uses_a_366_day_denominator():
    """Same 1 July start in 2028: 184 days of 366, not 365."""
    assert rule_entitlement_sessions(
        DoctorType.SALARIED, D("6"), datetime.date(2028, 7, 1), None, 2028
    ) == D("18.1")
    assert pro_rata_fraction(datetime.date(2028, 7, 1), None, 2028) == D(184) / D(366)


def test_doctor_who_left_before_the_year_gets_zero_not_none():
    """Zero, distinct from an AHP's None: this doctor is entitled to leave,
    just not to any in this year."""
    assert rule_entitlement_sessions(
        DoctorType.SALARIED, D("6"), None, datetime.date(2025, 12, 31), 2026
    ) == D("0.0")


# --- Template-implied sessions --------------------------------------------

def _template(doctor_id, *pairs):
    return {
        (doctor_id, day, period): session_type for day, period, session_type in pairs
    }


def test_template_sessions_counts_every_type_except_no_surgery():
    """ADMIN_TIME and WFH are working sessions -- the same definition
    leave_charging uses to decide a slot is chargeable. This is the
    assertion most likely to be "fixed" into agreement with the coverage
    endpoint's narrower _COUNTED_TYPES, which would be wrong."""
    template = _template(
        1,
        (Day.MONDAY, Period.AM, MasterSessionType.REQUIRES_ROOM),
        (Day.MONDAY, Period.PM, MasterSessionType.ADMIN_TIME),
        (Day.TUESDAY, Period.AM, MasterSessionType.WFH),
        (Day.TUESDAY, Period.PM, MasterSessionType.PRE_ASSIGNED),
        (Day.WEDNESDAY, Period.AM, MasterSessionType.NO_SURGERY),
    )
    assert template_sessions_per_week(1, template) == 4


def test_template_sessions_ignores_other_doctors():
    template = {
        **_template(1, (Day.MONDAY, Period.AM, MasterSessionType.REQUIRES_ROOM)),
        **_template(2, (Day.MONDAY, Period.AM, MasterSessionType.REQUIRES_ROOM)),
        **_template(2, (Day.MONDAY, Period.PM, MasterSessionType.REQUIRES_ROOM)),
    }
    assert template_sessions_per_week(1, template) == 1
    assert template_sessions_per_week(2, template) == 2


def test_unpopulated_template_is_zero():
    assert template_sessions_per_week(1, {}) == 0


# --- build_entitlement -----------------------------------------------------

def _build(**kwargs):
    defaults = dict(
        doctor_type=DoctorType.SALARIED,
        sessions_per_week=D("6"),
        start_date=None,
        end_date=None,
        year=2026,
    )
    return build_entitlement(**{**defaults, **kwargs})


def test_no_stored_row_is_just_the_rule():
    result = _build()
    assert result.rule_sessions == D("36.0")
    assert result.override_sessions is None
    assert result.total_sessions == D("36.0")
    assert result.weeks == D("6")
    assert result.full_year_sessions == D("36.0")


def test_override_replaces_the_rule_figure():
    result = _build(override_sessions=D("40.0"))
    assert result.rule_sessions == D("36.0")
    assert result.override_sessions == D("40.0")
    assert result.total_sessions == D("40.0")


def test_carry_over_and_adjustment_are_added_to_the_rule():
    result = _build(carry_over_sessions=D("4.0"), adjustment_sessions=D("-2.0"))
    assert result.total_sessions == D("38.0")


def test_carry_over_and_adjustment_are_added_to_an_override():
    result = _build(
        override_sessions=D("40.0"),
        carry_over_sessions=D("4.0"),
        adjustment_sessions=D("1.0"),
    )
    assert result.total_sessions == D("45.0")


def test_override_of_zero_is_honoured_not_treated_as_absent():
    """0 is a real override (someone whose leave is handled elsewhere this
    year); only None means "use the rule"."""
    result = _build(override_sessions=D("0.0"))
    assert result.total_sessions == D("0.0")


def test_unentitled_type_ignores_any_stored_row():
    result = _build(
        doctor_type=DoctorType.AHP,
        override_sessions=D("40.0"),
        carry_over_sessions=D("5.0"),
    )
    assert result.weeks is None
    assert result.rule_sessions is None
    assert result.total_sessions is None
    assert result.carry_over_sessions == D("0.0")


def test_pro_rata_and_carry_over_compose():
    """Pro-rating applies to the rule figure only -- carry-over is a real
    balance brought forward and is not scaled down by a mid-year start."""
    result = _build(start_date=datetime.date(2026, 7, 1), carry_over_sessions=D("4.0"))
    assert result.rule_sessions == D("18.1")
    assert result.total_sessions == D("22.1")
