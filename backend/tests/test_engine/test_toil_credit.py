"""Unit tests for the TOIL credit rule (TOIL or payment for extra sessions
plan, Task 3). Pure-function tests over plain sets and unsaved
`ExtraSessionEntry` instances -- no `client`, no `seeded`, no DB.

Sits under `tests/test_engine/` alongside `test_leave_charging.py` and
`test_leave_entitlement.py`: none of the three is an engine module, but this
is where their pure-logic siblings live.
"""
import datetime
from dataclasses import dataclass
from decimal import Decimal

from app.models import ExtraSessionEntry
from app.models.enums import ExtraSessionCompensation, Period
from app.toil_credit import (
    SKIP_BLOCKED,
    SKIP_CLOSED,
    SKIP_ON_LEAVE,
    SKIP_OUTSIDE_WINDOW,
    credit_skip_reason,
    summarise_toil_credit,
)

MONDAY = datetime.date(2026, 8, 3)
TUESDAY = datetime.date(2026, 8, 4)
DECEMBER = datetime.date(2026, 12, 7)


@dataclass
class _Doctor:
    """The `doctor_window._HasWindow` shape, with no ORM instance needed."""

    code: str = "AA"
    start_date: datetime.date | None = None
    end_date: datetime.date | None = None


def _entry(doctor_id=1, day=MONDAY, period=Period.AM, compensation=ExtraSessionCompensation.TOIL):
    return ExtraSessionEntry(
        doctor_id=doctor_id, date=day, period=period, compensation=compensation
    )


def _reason(
    doctor_id=1,
    day=MONDAY,
    period=Period.AM,
    leave=frozenset(),
    blocked=frozenset(),
    closed=frozenset(),
    doctor=None,
):
    return credit_skip_reason(
        doctor_id, day, period, leave, blocked, closed,
        _Doctor() if doctor is None else doctor,
    )


# --- The predicate ---------------------------------------------------------

def test_a_plain_extra_session_is_credited():
    assert _reason() is None


def test_leave_on_the_slot_skips():
    assert _reason(leave={(1, MONDAY, Period.AM)}) == SKIP_ON_LEAVE


def test_leave_on_the_other_period_does_not_skip():
    assert _reason(leave={(1, MONDAY, Period.PM)}) is None


def test_another_doctors_leave_does_not_skip():
    """The key sets are practice-wide, so the doctor_id must be part of the
    membership test and not just the date and period."""
    assert _reason(leave={(2, MONDAY, Period.AM)}) is None


def test_blocked_on_the_slot_skips():
    assert _reason(blocked={(1, MONDAY, Period.AM)}) == SKIP_BLOCKED


def test_another_doctors_blocked_row_does_not_skip():
    assert _reason(blocked={(2, MONDAY, Period.AM)}) is None


def test_a_closure_on_the_slot_skips():
    assert _reason(closed={(MONDAY, Period.AM)}) == SKIP_CLOSED


def test_a_closure_on_the_other_period_does_not_skip():
    assert _reason(closed={(MONDAY, Period.PM)}) is None


def test_a_date_before_the_start_date_skips():
    doctor = _Doctor(start_date=TUESDAY)
    assert _reason(doctor=doctor) == SKIP_OUTSIDE_WINDOW


def test_a_date_after_the_end_date_skips():
    doctor = _Doctor(end_date=datetime.date(2026, 7, 31))
    assert _reason(doctor=doctor) == SKIP_OUTSIDE_WINDOW


def test_a_date_inside_the_window_is_credited():
    doctor = _Doctor(start_date=MONDAY, end_date=MONDAY)
    assert _reason(doctor=doctor) is None


def test_an_unknown_doctor_skips_only_the_window_check():
    """`None` means the caller does not know the doctor; the window is not
    guessed at, but the other three exclusions still apply."""
    assert credit_skip_reason(1, MONDAY, Period.AM, set(), set(), set(), None) is None
    assert (
        credit_skip_reason(
            1, MONDAY, Period.AM, {(1, MONDAY, Period.AM)}, set(), set(), None
        )
        == SKIP_ON_LEAVE
    )


def test_the_template_is_not_consulted_at_all():
    """The deliberate difference from `leave_charging.exemption_reason`: an
    extra session is normally on a slot with no template row or a NO_SURGERY
    one, which that predicate exempts. Reusing it would zero almost every
    credit, so this one takes no template argument."""
    import inspect

    assert "template" not in inspect.signature(credit_skip_reason).parameters


# --- Precedence ------------------------------------------------------------

def test_leave_wins_over_blocked_closed_and_window():
    doctor = _Doctor(start_date=TUESDAY)
    assert _reason(
        leave={(1, MONDAY, Period.AM)},
        blocked={(1, MONDAY, Period.AM)},
        closed={(MONDAY, Period.AM)},
        doctor=doctor,
    ) == SKIP_ON_LEAVE


def test_blocked_wins_over_closed_and_window():
    doctor = _Doctor(start_date=TUESDAY)
    assert _reason(
        blocked={(1, MONDAY, Period.AM)},
        closed={(MONDAY, Period.AM)},
        doctor=doctor,
    ) == SKIP_BLOCKED


def test_closed_wins_over_the_window():
    doctor = _Doctor(start_date=TUESDAY)
    assert _reason(closed={(MONDAY, Period.AM)}, doctor=doctor) == SKIP_CLOSED


# --- The summariser --------------------------------------------------------

def _summarise(entries, leave=frozenset(), blocked=frozenset(), closed=frozenset(), doctors=None):
    return summarise_toil_credit(
        entries, leave, blocked, closed, {1: _Doctor()} if doctors is None else doctors
    )


def test_each_toil_session_is_worth_exactly_one():
    summary = _summarise([_entry(), _entry(period=Period.PM)])
    assert summary.credited_sessions == Decimal("2.0")
    assert summary.toil_entries == 2


def test_the_credit_is_a_decimal():
    """It composes with `leave_entitlement.py`'s other addends with no cast
    at the call site."""
    assert isinstance(_summarise([_entry()]).credited_sessions, Decimal)


def test_payment_entries_are_filtered_out():
    summary = _summarise([
        _entry(),
        _entry(period=Period.PM, compensation=ExtraSessionCompensation.PAYMENT),
    ])
    assert summary.credited_sessions == Decimal("1.0")
    assert summary.toil_entries == 1


def test_no_entries_credits_nothing():
    summary = _summarise([])
    assert summary.credited_sessions == Decimal("0.0")
    assert summary.toil_entries == 0
    assert set(summary.skipped_by_reason) == {
        SKIP_ON_LEAVE, SKIP_BLOCKED, SKIP_CLOSED, SKIP_OUTSIDE_WINDOW
    }
    assert sum(summary.skipped_by_reason.values()) == 0


def test_skips_are_counted_by_reason_and_not_credited():
    summary = _summarise(
        [
            _entry(),
            _entry(day=TUESDAY),
            _entry(period=Period.PM),
            _entry(day=DECEMBER),
        ],
        leave={(1, TUESDAY, Period.AM)},
        closed={(MONDAY, Period.PM)},
        doctors={1: _Doctor(end_date=datetime.date(2026, 11, 30))},
    )
    assert summary.toil_entries == 4
    assert summary.credited_sessions == Decimal("1.0")
    assert summary.skipped_by_reason == {
        SKIP_ON_LEAVE: 1,
        SKIP_BLOCKED: 0,
        SKIP_CLOSED: 1,
        SKIP_OUTSIDE_WINDOW: 1,
    }


def test_a_mixed_doctor_iterable_summarises_per_entry():
    """`doctor_id` is read off each entry, so one call over the whole
    practice's rows gives the right answer for each."""
    summary = _summarise(
        [_entry(doctor_id=1), _entry(doctor_id=2)],
        leave={(2, MONDAY, Period.AM)},
        doctors={1: _Doctor("AA"), 2: _Doctor("BB")},
    )
    assert summary.credited_sessions == Decimal("1.0")
    assert summary.skipped_by_reason[SKIP_ON_LEAVE] == 1


def test_each_doctors_own_window_is_used():
    summary = _summarise(
        [_entry(doctor_id=1), _entry(doctor_id=2)],
        doctors={1: _Doctor("AA"), 2: _Doctor("BB", start_date=TUESDAY)},
    )
    assert summary.credited_sessions == Decimal("1.0")
    assert summary.skipped_by_reason[SKIP_OUTSIDE_WINDOW] == 1
