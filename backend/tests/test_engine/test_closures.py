"""M5 practice closures (bank holiday weeks): cross-cutting engine tests.

Covers context.load_context() closure loading, Phase 0's duty_on_closed_date
error, Phase 2's slot omission, Phase 5's silent skip (no spurious
no_eligible_doctor warning), and Phase 12's closure-aware expected-count
matrix for duty coverage plus its clinic_coverage skip. End-to-end write
behaviour (RotaClosure snapshot rows) is in test_generate.py; the
snapshot-vs-live-table isolation test (delete a PracticeClosure after
generation, assert /issues is unchanged) is in test_grid_utils.py.
"""
import datetime

from app.engine.context import load_context
from app.engine.phases.phase0 import run_phase0
from app.engine.phases.phase2 import run_phase2
from app.engine.phases.phase5 import run_phase5
from app.engine.phases.phase12 import run_phase12
from app.engine.datatypes import DecisionLog
from app.engine.week_map import build_first_open_weekday, build_week_dates
from app.models.enums import Day, DutyType, MasterSessionType, Period

from .factories import (
    make_clinic_type,
    make_closure,
    make_doctor,
    make_duty,
    make_master_session,
    make_template,
)


def _build(session, config):
    ctx = load_context(session, config)
    grid, counters = run_phase2(ctx, config, session)
    return ctx, grid, counters


class TestBuildFirstOpenWeekday:
    """Pure function tests -- mirrors the case matrix the frontend's
    dutyWeekSlots.ts must reproduce (see M5 plan review note 2)."""

    def test_open_week_first_open_is_monday(self):
        start = datetime.date(2026, 1, 5)  # a Monday
        week_dates = build_week_dates(start, 1)
        result = build_first_open_weekday(week_dates, closed_dates=frozenset())
        assert result[1] == Day.MONDAY

    def test_closed_monday_first_open_is_tuesday(self):
        start = datetime.date(2026, 1, 5)
        week_dates = build_week_dates(start, 1)
        result = build_first_open_weekday(week_dates, closed_dates=frozenset({start}))
        assert result[1] == Day.TUESDAY

    def test_closed_mon_and_tue_first_open_is_wednesday(self):
        start = datetime.date(2026, 1, 5)
        week_dates = build_week_dates(start, 1)
        closed = frozenset({start, start + datetime.timedelta(days=1)})
        result = build_first_open_weekday(week_dates, closed_dates=closed)
        assert result[1] == Day.WEDNESDAY

    def test_fully_closed_week_is_none(self):
        start = datetime.date(2026, 1, 5)
        week_dates = build_week_dates(start, 1)
        closed = frozenset(week_dates.values())
        result = build_first_open_weekday(week_dates, closed_dates=closed)
        assert result[1] is None

    def test_per_week_independent(self):
        start = datetime.date(2026, 1, 5)
        week_dates = build_week_dates(start, 2)
        result = build_first_open_weekday(week_dates, closed_dates=frozenset({start}))
        assert result[1] == Day.TUESDAY  # week 1 Monday closed
        assert result[2] == Day.MONDAY  # week 2 unaffected


class TestContextClosures:
    def test_closed_dates_loaded_and_filtered_to_range(self, session, config_1wk, monday):
        after = monday + datetime.timedelta(days=7)  # outside a 1wk run
        make_closure(session, monday, name="Bank Holiday")
        make_closure(session, after)

        ctx = load_context(session, config_1wk)

        assert ctx.closed_dates == {monday}

    def test_first_open_weekday_by_week_reflects_closure(self, session, config_1wk, monday):
        make_closure(session, monday)

        ctx = load_context(session, config_1wk)

        assert ctx.first_open_weekday_by_week[1] == Day.TUESDAY

    def test_no_closures_defaults_to_monday(self, session, config_1wk):
        ctx = load_context(session, config_1wk)
        assert ctx.first_open_weekday_by_week[1] == Day.MONDAY


class TestPhase0DutyOnClosedDate:
    def test_duty_on_closed_date_errors(self, session, config_1wk, monday):
        t = make_template(session, is_active=True)
        d = make_doctor(session, code="AA")
        make_master_session(
            session, t, d, week=1, day=Day.MONDAY, period=Period.AM,
            session_type=MasterSessionType.REQUIRES_ROOM,
        )
        make_closure(session, monday)
        make_duty(session, monday, Period.AM, d, DutyType.PRIMARY)

        ctx = load_context(session, config_1wk)
        issues = run_phase0(ctx, config_1wk)

        matching = [i for i in issues if i.check == "duty_on_closed_date"]
        assert len(matching) == 1
        assert matching[0].severity == "error"

    def test_duty_on_open_date_does_not_error(self, session, config_1wk, monday):
        t = make_template(session, is_active=True)
        d = make_doctor(session, code="AA")
        make_master_session(
            session, t, d, week=1, day=Day.MONDAY, period=Period.AM,
            session_type=MasterSessionType.REQUIRES_ROOM,
        )
        make_duty(session, monday, Period.AM, d, DutyType.PRIMARY)

        ctx = load_context(session, config_1wk)
        issues = run_phase0(ctx, config_1wk)

        assert not any(i.check == "duty_on_closed_date" for i in issues)


class TestPhase2ClosedDateSlotOmission:
    def test_no_slot_built_on_closed_date(self, session, config_1wk, monday):
        t = make_template(session, is_active=True)
        d = make_doctor(session, code="AA")
        make_master_session(
            session, t, d, week=1, day=Day.MONDAY, period=Period.AM,
            session_type=MasterSessionType.REQUIRES_ROOM,
        )
        make_closure(session, monday)

        ctx, grid, _counters = _build(session, config_1wk)

        assert grid.get(d.id, 1, Day.MONDAY, Period.AM) is None

    def test_slot_built_on_open_date_in_same_week(self, session, config_1wk, monday):
        t = make_template(session, is_active=True)
        d = make_doctor(session, code="AA")
        make_master_session(
            session, t, d, week=1, day=Day.MONDAY, period=Period.AM,
            session_type=MasterSessionType.REQUIRES_ROOM,
        )
        make_master_session(
            session, t, d, week=1, day=Day.TUESDAY, period=Period.AM,
            session_type=MasterSessionType.REQUIRES_ROOM,
        )
        make_closure(session, monday)

        ctx, grid, _counters = _build(session, config_1wk)

        assert grid.get(d.id, 1, Day.TUESDAY, Period.AM) is not None


class TestPhase5ClosedDateSkip:
    def test_no_eligible_doctor_warning_on_closed_date(self, session, config_1wk, monday):
        """Without the Phase 5 skip, an omitted slot (Phase 2) would leave
        every doctor ineligible and raise a spurious no_eligible_doctor
        warning -- the closed date must produce silence instead."""
        t = make_template(session, is_active=True)
        d = make_doctor(session, code="AA")
        make_master_session(
            session, t, d, week=1, day=Day.MONDAY, period=Period.AM,
            session_type=MasterSessionType.REQUIRES_ROOM,
        )
        make_closure(session, monday)
        make_clinic_type(
            session, name="Dragon", room_required=False,
            schedules=[(Day.MONDAY, Period.AM)], doctor_eligibilities=[(d.id, 1)],
        )

        ctx, grid, counters = _build(session, config_1wk)
        log = DecisionLog()
        issues = run_phase5(ctx, grid, counters, log)

        assert not any(i.check == "no_eligible_doctor" for i in issues)


class TestPhase12ClosureAwareDutyCoverage:
    def test_closed_monday_expects_zero_primary_and_secondary(
        self, session, config_1wk, monday
    ):
        t = make_template(session, is_active=True)
        d = make_doctor(session, code="AA")
        make_master_session(
            session, t, d, week=1, day=Day.MONDAY, period=Period.AM,
            session_type=MasterSessionType.REQUIRES_ROOM,
        )
        make_closure(session, monday)

        ctx, grid, _counters = _build(session, config_1wk)
        issues = run_phase12(ctx, grid)

        assert not any(
            i.check in ("duty_coverage_primary", "duty_coverage_secondary")
            and i.day == Day.MONDAY
            for i in issues
        )

    def test_closed_monday_moves_secondary_expectation_to_tuesday(
        self, session, config_1wk, monday
    ):
        t = make_template(session, is_active=True)
        d = make_doctor(session, code="AA")
        make_master_session(
            session, t, d, week=1, day=Day.TUESDAY, period=Period.AM,
            session_type=MasterSessionType.REQUIRES_ROOM,
        )
        make_closure(session, monday)

        ctx, grid, _counters = _build(session, config_1wk)
        issues = run_phase12(ctx, grid)

        secondary_issue = next(
            i for i in issues if i.check == "duty_coverage_secondary"
            and i.day == Day.TUESDAY and i.period == Period.AM
        )
        assert "Expected 1" in secondary_issue.message

    def test_open_week_unchanged_secondary_still_monday(self, session, config_1wk, monday):
        t = make_template(session, is_active=True)
        d = make_doctor(session, code="AA")
        make_master_session(
            session, t, d, week=1, day=Day.MONDAY, period=Period.AM,
            session_type=MasterSessionType.REQUIRES_ROOM,
        )
        ctx, grid, _counters = _build(session, config_1wk)
        issues = run_phase12(ctx, grid)

        secondary_issue = next(
            i for i in issues if i.check == "duty_coverage_secondary"
            and i.day == Day.MONDAY and i.period == Period.AM
        )
        assert "Expected 1" in secondary_issue.message
        assert not any(
            i.check == "duty_coverage_secondary" and i.day == Day.TUESDAY
            for i in issues
        )

    def test_fully_closed_week_expects_no_secondary_anywhere(
        self, session, config_1wk, monday
    ):
        t = make_template(session, is_active=True)
        d = make_doctor(session, code="AA")
        # No template sessions at all -- an entirely closed week has nothing
        # to schedule, but Phase 12 still walks every weekday/period.
        for offset in range(5):
            make_closure(session, monday + datetime.timedelta(days=offset))

        ctx, grid, _counters = _build(session, config_1wk)
        issues = run_phase12(ctx, grid)

        assert not any(i.check == "duty_coverage_secondary" for i in issues)
        assert not any(i.check == "duty_coverage_primary" for i in issues)


class TestPhase12ClinicCoverageClosureSkip:
    def test_no_clinic_coverage_warning_on_closed_date(self, session, config_1wk, monday):
        t = make_template(session, is_active=True)
        d = make_doctor(session, code="AA")
        make_master_session(
            session, t, d, week=1, day=Day.MONDAY, period=Period.AM,
            session_type=MasterSessionType.REQUIRES_ROOM,
        )
        make_closure(session, monday)
        make_clinic_type(
            session, name="Dragon", room_required=False,
            schedules=[(Day.MONDAY, Period.AM)], doctor_eligibilities=[(d.id, 1)],
        )

        ctx, grid, counters = _build(session, config_1wk)
        log = DecisionLog()
        run_phase5(ctx, grid, counters, log)
        issues = run_phase12(ctx, grid)

        assert not any(i.check == "clinic_coverage" for i in issues)