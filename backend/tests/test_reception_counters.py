"""Unit tests for the reception role counter aggregation.

Not an API test -- `compute_role_counters` is the shared seam the future
front-desk-rotation generator calls directly, so it is tested against a bare
DB session (the `session` fixture in tests/conftest.py) rather than through
the router.
"""
import datetime

from app.models import (
    ReceptionLeaveEntry,
    ReceptionRota,
    ReceptionRotaSession,
    ReceptionStaff,
)
from app.models.enums import ReceptionRole
from app.reception_counters import (
    assignment_counter_window,
    compute_role_counters,
    default_counter_window,
)

MONDAY = datetime.date(2026, 8, 10)  # week commencing, used as the anchor


def _staff(session, code="R1", active=True):
    s = ReceptionStaff(code=code, active=active)
    session.add(s)
    session.flush()
    return s


def _rota(session, date):
    r = ReceptionRota(date=date)
    session.add(r)
    session.flush()
    return r


def _sessions(session, rota, staff, roles, first_hour=9.0):
    """One row per role, on consecutive half-hour slots (the unique
    constraint is (rota, staff, hour), so they cannot share an hour)."""
    for i, role in enumerate(roles):
        session.add(
            ReceptionRotaSession(
                rota_id=rota.id,
                staff_id=staff.id,
                hour=first_hour + 0.5 * i,
                role=role,
            )
        )
    session.flush()


def _row(result, staff):
    return next(r for r in result.staff if r.staff_id == staff.id)


# --- default_counter_window ------------------------------------------------


def test_window_anchors_on_monday_not_today_minus_28():
    from_date, to_date = default_counter_window(MONDAY)
    assert to_date == MONDAY
    assert from_date == datetime.date(2026, 7, 13)  # four weeks before Monday
    assert (to_date - from_date).days == 28


def test_window_span_grows_through_the_week():
    """Anchored to the Monday, so the span is 29 days on a Monday and 33 on a
    Friday -- the current week to date is always included."""
    friday = MONDAY + datetime.timedelta(days=4)
    mon_from, mon_to = default_counter_window(MONDAY)
    fri_from, fri_to = default_counter_window(friday)

    assert mon_from == fri_from  # same anchor all week
    assert (mon_to - mon_from).days + 1 == 29
    assert (fri_to - fri_from).days + 1 == 33


def test_window_from_a_sunday_uses_that_weeks_monday():
    sunday = MONDAY + datetime.timedelta(days=6)
    from_date, to_date = default_counter_window(sunday)
    assert from_date == datetime.date(2026, 7, 13)
    assert to_date == sunday


# --- assignment_counter_window ---------------------------------------------


def test_assignment_window_on_a_monday_anchors_on_that_monday():
    from_date, to_date = assignment_counter_window(MONDAY)
    assert to_date == MONDAY
    assert from_date == datetime.date(2026, 7, 13)  # four weeks before Monday


def test_assignment_window_on_a_friday_ends_on_the_rota_date():
    """Same anchor as the Monday of that week, but the upper bound follows the
    rota's own date -- so each day in a generated week sees the days before
    it."""
    friday = MONDAY + datetime.timedelta(days=4)
    mon_from, _ = assignment_counter_window(MONDAY)
    fri_from, fri_to = assignment_counter_window(friday)

    assert fri_from == mon_from
    assert fri_to == friday
    assert (fri_to - fri_from).days + 1 == 33


def test_assignment_window_spans_a_month_boundary():
    """1 Sep 2026 is a Tuesday; its Monday is 31 Aug, four weeks back is
    3 Aug."""
    tuesday = datetime.date(2026, 9, 1)
    from_date, to_date = assignment_counter_window(tuesday)
    assert from_date == datetime.date(2026, 8, 3)
    assert to_date == tuesday


def test_assignment_window_ignores_today_unlike_the_page_window(session):
    """The property the whole helper exists for: a future-dated generated day
    is visible to the assignment window for a later rota date, while
    `default_counter_window` computed today excludes it entirely."""
    today = MONDAY
    tuesday = MONDAY + datetime.timedelta(days=1)
    staff = _staff(session)
    # Monday is generated and assigned "ahead of time" -- from today's point of
    # view Tuesday is in the future.
    _sessions(session, _rota(session, MONDAY), staff, [ReceptionRole.FRONT_DESK] * 6)
    _sessions(session, _rota(session, tuesday), staff, [ReceptionRole.FRONT_DESK] * 6)

    page_from, page_to = default_counter_window(today)
    page = compute_role_counters(session, page_from, page_to)
    assert _row(page, staff).role_slots[ReceptionRole.FRONT_DESK] == 6

    # Assigning Wednesday sees both Monday and Tuesday.
    wednesday = MONDAY + datetime.timedelta(days=2)
    assign_from, assign_to = assignment_counter_window(wednesday)
    assigning = compute_role_counters(session, assign_from, assign_to)
    assert _row(assigning, staff).role_slots[ReceptionRole.FRONT_DESK] == 12


# --- compute_role_counters -------------------------------------------------


def test_counts_slots_hours_and_days_present(session):
    staff = _staff(session)
    rota = _rota(session, MONDAY)
    _sessions(session, rota, staff, [ReceptionRole.PHONES] * 3 + [ReceptionRole.ADMIN])

    result = compute_role_counters(session, MONDAY, MONDAY)
    row = _row(result, staff)

    assert row.role_slots[ReceptionRole.PHONES] == 3
    assert row.role_slots[ReceptionRole.ADMIN] == 1
    assert row.hours_worked == 2.0
    assert row.days_present == 1
    assert result.days_counted == 1
    assert (result.from_date, result.to_date) == (MONDAY, MONDAY)


def test_role_slots_are_zero_filled_for_every_role(session):
    staff = _staff(session)
    rota = _rota(session, MONDAY)
    _sessions(session, rota, staff, [ReceptionRole.PHONES])

    row = _row(compute_role_counters(session, MONDAY, MONDAY), staff)

    assert set(row.role_slots) == set(ReceptionRole)
    assert row.role_slots[ReceptionRole.WOLVERCOTE] == 0


def test_not_working_counts_as_a_role_but_not_as_hours(session):
    staff = _staff(session)
    rota = _rota(session, MONDAY)
    _sessions(
        session,
        rota,
        staff,
        [ReceptionRole.PHONES, ReceptionRole.NOT_WORKING, ReceptionRole.NOT_WORKING],
    )

    row = _row(compute_role_counters(session, MONDAY, MONDAY), staff)

    assert row.role_slots[ReceptionRole.NOT_WORKING] == 2
    assert row.hours_worked == 0.5


def test_lunch_counts_as_hours_worked(session):
    """Design Decision 5 keeps ReceptionHoursPage's rule: everything except
    not_working is working time."""
    staff = _staff(session)
    rota = _rota(session, MONDAY)
    _sessions(session, rota, staff, [ReceptionRole.LUNCH, ReceptionRole.LUNCH])

    assert _row(compute_role_counters(session, MONDAY, MONDAY), staff).hours_worked == 1.0


def test_leave_excludes_counts_hours_and_days_present(session):
    staff = _staff(session)
    off_day, worked_day = MONDAY, MONDAY + datetime.timedelta(days=1)
    _sessions(session, _rota(session, off_day), staff, [ReceptionRole.PHONES] * 4)
    _sessions(session, _rota(session, worked_day), staff, [ReceptionRole.PHONES] * 2)
    session.add(ReceptionLeaveEntry(staff_id=staff.id, date=off_day))
    session.flush()

    row = _row(compute_role_counters(session, off_day, worked_day), staff)

    assert row.role_slots[ReceptionRole.PHONES] == 2
    assert row.hours_worked == 1.0
    assert row.days_present == 1
    # The leave day was still generated, so it stays in days_counted.
    assert compute_role_counters(session, off_day, worked_day).days_counted == 2


def test_leave_for_one_staff_member_does_not_affect_another(session):
    away = _staff(session, code="R1")
    present = _staff(session, code="R2")
    rota = _rota(session, MONDAY)
    _sessions(session, rota, away, [ReceptionRole.PHONES] * 2)
    _sessions(session, rota, present, [ReceptionRole.PHONES] * 2)
    session.add(ReceptionLeaveEntry(staff_id=away.id, date=MONDAY))
    session.flush()

    result = compute_role_counters(session, MONDAY, MONDAY)

    assert _row(result, away).hours_worked == 0.0
    assert _row(result, present).hours_worked == 1.0


def test_days_present_counts_a_multi_role_day_once(session):
    staff = _staff(session)
    rota = _rota(session, MONDAY)
    _sessions(session, rota, staff, [ReceptionRole.PHONES, ReceptionRole.ADMIN])

    assert _row(compute_role_counters(session, MONDAY, MONDAY), staff).days_present == 1


def test_active_staff_with_no_rows_appear_zero_filled(session):
    worked = _staff(session, code="R1")
    new_starter = _staff(session, code="R2")
    _sessions(session, _rota(session, MONDAY), worked, [ReceptionRole.PHONES])

    row = _row(compute_role_counters(session, MONDAY, MONDAY), new_starter)

    assert row.hours_worked == 0.0
    assert row.days_present == 0
    assert all(count == 0 for count in row.role_slots.values())


def test_inactive_staff_with_rows_still_appear(session):
    leaver = _staff(session, code="R1", active=False)
    _sessions(session, _rota(session, MONDAY), leaver, [ReceptionRole.PHONES] * 2)

    row = _row(compute_role_counters(session, MONDAY, MONDAY), leaver)

    assert row.active is False
    assert row.hours_worked == 1.0


def test_inactive_staff_with_no_rows_are_omitted(session):
    leaver = _staff(session, code="R1", active=False)

    result = compute_role_counters(session, MONDAY, MONDAY)

    assert [r.staff_id for r in result.staff] == []
    assert leaver.id is not None


def test_rows_outside_the_window_are_excluded(session):
    staff = _staff(session)
    before = MONDAY - datetime.timedelta(days=7)
    after = MONDAY + datetime.timedelta(days=7)
    _sessions(session, _rota(session, before), staff, [ReceptionRole.PHONES] * 4)
    _sessions(session, _rota(session, MONDAY), staff, [ReceptionRole.PHONES] * 2)
    _sessions(session, _rota(session, after), staff, [ReceptionRole.PHONES] * 6)

    result = compute_role_counters(session, MONDAY, MONDAY + datetime.timedelta(days=4))
    row = _row(result, staff)

    assert row.role_slots[ReceptionRole.PHONES] == 2
    assert result.days_counted == 1


def test_days_counted_reflects_sparse_generation(session):
    staff = _staff(session)
    for offset in (0, 3):
        _sessions(
            session,
            _rota(session, MONDAY + datetime.timedelta(days=offset)),
            staff,
            [ReceptionRole.PHONES],
        )

    result = compute_role_counters(session, *default_counter_window(MONDAY + datetime.timedelta(days=4)))

    assert result.days_counted == 2
    assert _row(result, staff).days_present == 2


def test_a_generated_but_empty_day_still_counts_as_a_day(session):
    _staff(session)
    _rota(session, MONDAY)

    assert compute_role_counters(session, MONDAY, MONDAY).days_counted == 1


def test_rows_are_ordered_by_staff_code(session):
    for code in ("Casey", "Alex", "Blake"):
        _staff(session, code=code)

    result = compute_role_counters(session, MONDAY, MONDAY)

    assert [r.code for r in result.staff] == ["Alex", "Blake", "Casey"]
