"""Unit tests for the leave chargeability rule (no-surgery leave exemption
plan, Task 2). Pure-function tests over plain dicts/sets and unsaved
`LeaveEntry` instances -- no `client`, no `seeded`, no DB (Design Decision 3).
"""
import datetime

from app.leave_charging import (
    EXEMPT_CLOSED,
    EXEMPT_NO_SURGERY,
    EXEMPT_NO_TEMPLATE_ROW,
    EXEMPT_WEEKEND,
    exemption_reason,
    summarise_leave_charging,
)
from app.models import LeaveEntry
from app.models.enums import Day, MasterSessionType, Period

MONDAY = datetime.date(2026, 8, 3)
SATURDAY = datetime.date(2026, 8, 8)
SUNDAY = datetime.date(2026, 8, 9)


def _template(doctor_id: int, day: Day, period: Period, session_type: MasterSessionType):
    return {(doctor_id, day, period): session_type}


def test_requires_room_is_chargeable():
    template = _template(1, Day.MONDAY, Period.AM, MasterSessionType.REQUIRES_ROOM)
    assert exemption_reason(1, MONDAY, Period.AM, template, set()) is None


def test_pre_assigned_is_chargeable():
    template = _template(1, Day.MONDAY, Period.AM, MasterSessionType.PRE_ASSIGNED)
    assert exemption_reason(1, MONDAY, Period.AM, template, set()) is None


def test_admin_time_is_chargeable():
    """Design Decision 2: charging asks whether the doctor was due at work,
    not whether they counted as clinical cover. ADMIN_TIME counts as zero
    for `_COUNTED_TYPES` coverage but is chargeable here -- the case most
    likely to be "fixed" into agreement with coverage later."""
    template = _template(1, Day.MONDAY, Period.AM, MasterSessionType.ADMIN_TIME)
    assert exemption_reason(1, MONDAY, Period.AM, template, set()) is None


def test_wfh_is_chargeable():
    template = _template(1, Day.MONDAY, Period.AM, MasterSessionType.WFH)
    assert exemption_reason(1, MONDAY, Period.AM, template, set()) is None


def test_no_surgery_is_exempt():
    template = _template(1, Day.MONDAY, Period.AM, MasterSessionType.NO_SURGERY)
    assert exemption_reason(1, MONDAY, Period.AM, template, set()) == EXEMPT_NO_SURGERY


def test_missing_template_row_is_exempt():
    assert exemption_reason(1, MONDAY, Period.AM, {}, set()) == EXEMPT_NO_TEMPLATE_ROW


def test_saturday_is_exempt_weekend():
    assert exemption_reason(1, SATURDAY, Period.AM, {}, set()) == EXEMPT_WEEKEND


def test_sunday_is_exempt_weekend():
    assert exemption_reason(1, SUNDAY, Period.AM, {}, set()) == EXEMPT_WEEKEND


def test_weekend_checked_before_any_template_lookup():
    """A stray weekend LeaveEntry is representable (POST /leave is not
    weekday-filtered). Indexing DAY_BY_WEEKDAY with a Saturday would
    KeyError into a 500 if the weekend check ran after the template
    lookup -- this must not raise."""
    exemption_reason(1, SATURDAY, Period.AM, {}, set())


def test_closure_on_working_slot_is_exempt_closed():
    template = _template(1, Day.MONDAY, Period.AM, MasterSessionType.REQUIRES_ROOM)
    closed = {(MONDAY, Period.AM)}
    assert exemption_reason(1, MONDAY, Period.AM, template, closed) == EXEMPT_CLOSED


def test_closure_on_no_surgery_slot_is_no_surgery_not_closed():
    """Reversal from the provisional plan: `closed` must mean "would have
    worked but the practice shut" so the entitlement ticket's pro-rata
    bank-holiday number is recoverable. A closure landing on a NO_SURGERY
    slot reports no_surgery, not closed."""
    template = _template(1, Day.MONDAY, Period.AM, MasterSessionType.NO_SURGERY)
    closed = {(MONDAY, Period.AM)}
    assert exemption_reason(1, MONDAY, Period.AM, template, closed) == EXEMPT_NO_SURGERY


def test_closure_on_slot_with_no_template_row_is_no_template_row_not_closed():
    closed = {(MONDAY, Period.AM)}
    assert exemption_reason(1, MONDAY, Period.AM, {}, closed) == EXEMPT_NO_TEMPLATE_ROW


def test_half_day_closure_exempts_only_its_own_period():
    template = {
        (1, Day.MONDAY, Period.AM): MasterSessionType.REQUIRES_ROOM,
        (1, Day.MONDAY, Period.PM): MasterSessionType.REQUIRES_ROOM,
    }
    closed = {(MONDAY, Period.AM)}
    assert exemption_reason(1, MONDAY, Period.AM, template, closed) == EXEMPT_CLOSED
    assert exemption_reason(1, MONDAY, Period.PM, template, closed) is None


def test_summary_invariant_totals_sum_across_mixed_entries():
    template = {
        (1, Day.MONDAY, Period.AM): MasterSessionType.REQUIRES_ROOM,
        (1, Day.MONDAY, Period.PM): MasterSessionType.NO_SURGERY,
    }
    closed = {(MONDAY, Period.PM)}
    entries = [
        LeaveEntry(doctor_id=1, date=MONDAY, period=Period.AM),  # chargeable
        LeaveEntry(doctor_id=1, date=MONDAY, period=Period.PM),  # no_surgery
        LeaveEntry(doctor_id=1, date=SATURDAY, period=Period.AM),  # weekend
        LeaveEntry(doctor_id=1, date=MONDAY.replace(day=4), period=Period.AM),  # no_template_row
    ]
    summary = summarise_leave_charging(entries, template, closed)
    assert summary.total_entries == 4
    assert (
        summary.chargeable_sessions + sum(summary.exempt_by_reason.values())
        == summary.total_entries
    )
    assert summary.chargeable_sessions == 1
    assert summary.exempt_by_reason[EXEMPT_NO_SURGERY] == 1
    assert summary.exempt_by_reason[EXEMPT_WEEKEND] == 1
    assert summary.exempt_by_reason[EXEMPT_NO_TEMPLATE_ROW] == 1
    assert summary.exempt_by_reason[EXEMPT_CLOSED] == 0


def test_summary_all_four_reason_keys_present_when_nothing_exempt():
    template = _template(1, Day.MONDAY, Period.AM, MasterSessionType.REQUIRES_ROOM)
    entries = [LeaveEntry(doctor_id=1, date=MONDAY, period=Period.AM)]
    summary = summarise_leave_charging(entries, template, set())
    assert summary.chargeable_sessions == 1
    assert summary.exempt_by_reason == {
        EXEMPT_WEEKEND: 0,
        EXEMPT_NO_TEMPLATE_ROW: 0,
        EXEMPT_NO_SURGERY: 0,
        EXEMPT_CLOSED: 0,
    }


def test_summary_empty_iterable_is_all_zeros_no_keyerror():
    summary = summarise_leave_charging([], {}, set())
    assert summary.total_entries == 0
    assert summary.chargeable_sessions == 0
    assert summary.exempt_by_reason == {
        EXEMPT_WEEKEND: 0,
        EXEMPT_NO_TEMPLATE_ROW: 0,
        EXEMPT_NO_SURGERY: 0,
        EXEMPT_CLOSED: 0,
    }


def test_summary_mixed_doctor_list_uses_each_entrys_own_doctor_id():
    """Decision 8's property: a mixed-doctor iterable summarises correctly
    with no change, since summarise_leave_charging reads doctor_id off each
    entry rather than taking one doctor_id parameter."""
    template = {
        (1, Day.MONDAY, Period.AM): MasterSessionType.REQUIRES_ROOM,
        (2, Day.MONDAY, Period.AM): MasterSessionType.NO_SURGERY,
    }
    entries = [
        LeaveEntry(doctor_id=1, date=MONDAY, period=Period.AM),  # chargeable
        LeaveEntry(doctor_id=2, date=MONDAY, period=Period.AM),  # no_surgery
    ]
    summary = summarise_leave_charging(entries, template, set())
    assert summary.chargeable_sessions == 1
    assert summary.exempt_by_reason[EXEMPT_NO_SURGERY] == 1
