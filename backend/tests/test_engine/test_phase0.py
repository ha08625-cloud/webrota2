import datetime

from app.engine.context import load_context
from app.engine.phases.phase0 import run_phase0
from app.models import RotaConfig
from app.models.enums import Day, DutyType, Period

from .factories import make_doctor, make_duty, make_leave, make_master_session, make_template


def _errors(issues):
    return [i for i in issues if i.severity == "error"]


class TestActiveTemplate:
    def test_missing_active_template_is_error(self, session, config_1wk):
        ctx = load_context(session, config_1wk)  # no template created at all
        issues = run_phase0(ctx, config_1wk)
        assert any(i.check == "active_template" for i in _errors(issues))

    def test_multiple_active_templates_is_error(self, session, config_1wk):
        make_template(session, name="One", is_active=True)
        make_template(session, name="Two", is_active=True)
        ctx = load_context(session, config_1wk)
        issues = run_phase0(ctx, config_1wk)
        assert any(i.check == "active_template" for i in _errors(issues))

    def test_single_active_template_no_error(self, session, config_1wk):
        make_template(session, is_active=True)
        ctx = load_context(session, config_1wk)
        issues = run_phase0(ctx, config_1wk)
        assert not any(i.check == "active_template" for i in issues)


class TestConfigChecks:
    def test_start_date_not_monday_is_error(self, session):
        make_template(session, is_active=True)
        bad_config = RotaConfig(
            start_date=datetime.date(2026, 1, 6), num_weeks=1, template_start_week=1,
        )  # a Tuesday
        ctx = load_context(session, bad_config)
        issues = run_phase0(ctx, bad_config)
        assert any(i.check == "start_date_monday" for i in _errors(issues))

    def test_start_date_monday_no_error(self, session, config_1wk):
        make_template(session, is_active=True)
        ctx = load_context(session, config_1wk)
        issues = run_phase0(ctx, config_1wk)
        assert not any(i.check == "start_date_monday" for i in issues)

    def test_num_weeks_invalid_is_error(self, session, monday):
        make_template(session, is_active=True)
        bad_config = RotaConfig(start_date=monday, num_weeks=3, template_start_week=1)
        ctx = load_context(session, bad_config)
        issues = run_phase0(ctx, bad_config)
        assert any(i.check == "num_weeks" for i in _errors(issues))

    def test_template_start_week_too_low_is_error(self, session, monday):
        make_template(session, is_active=True)
        bad_config = RotaConfig(start_date=monday, num_weeks=1, template_start_week=0)
        ctx = load_context(session, bad_config)
        issues = run_phase0(ctx, bad_config)
        assert any(i.check == "template_start_week" for i in _errors(issues))

    def test_template_start_week_too_high_is_error(self, session, monday):
        make_template(session, is_active=True)
        bad_config = RotaConfig(start_date=monday, num_weeks=1, template_start_week=5)
        ctx = load_context(session, bad_config)
        issues = run_phase0(ctx, bad_config)
        assert any(i.check == "template_start_week" for i in _errors(issues))


class TestDutyOnLeave:
    def test_duty_doctor_on_leave_is_error(self, session, config_1wk, monday):
        make_template(session, is_active=True)
        d = make_doctor(session, code="AA")
        make_duty(session, monday, Period.AM, d, DutyType.PRIMARY)
        make_leave(session, d, monday, Period.AM)

        ctx = load_context(session, config_1wk)
        issues = run_phase0(ctx, config_1wk)

        errors = _errors(issues)
        duty_issue = next(i for i in errors if i.check == "duty_on_leave")
        assert duty_issue.week == 1
        assert duty_issue.day == Day.MONDAY
        assert duty_issue.period == Period.AM

    def test_duty_doctor_not_on_leave_no_error(self, session, config_1wk, monday):
        make_template(session, is_active=True)
        d = make_doctor(session, code="AA")
        make_duty(session, monday, Period.AM, d, DutyType.PRIMARY)

        ctx = load_context(session, config_1wk)
        issues = run_phase0(ctx, config_1wk)

        assert not any(i.check == "duty_on_leave" for i in issues)

    def test_leave_different_period_same_day_no_error(self, session, config_1wk, monday):
        make_template(session, is_active=True)
        d = make_doctor(session, code="AA")
        make_duty(session, monday, Period.AM, d, DutyType.PRIMARY)
        make_leave(session, d, monday, Period.PM)  # different period -> no overlap

        ctx = load_context(session, config_1wk)
        issues = run_phase0(ctx, config_1wk)

        assert not any(i.check == "duty_on_leave" for i in issues)

    def test_multiple_duty_doctors_on_leave_each_flagged(self, session, config_1wk, monday):
        make_template(session, is_active=True)
        d1 = make_doctor(session, code="AA")
        d2 = make_doctor(session, code="BB")
        make_duty(session, monday, Period.AM, d1, DutyType.PRIMARY)
        make_duty(session, monday, Period.AM, d2, DutyType.SECONDARY)
        make_leave(session, d1, monday, Period.AM)
        make_leave(session, d2, monday, Period.AM)

        ctx = load_context(session, config_1wk)
        issues = run_phase0(ctx, config_1wk)

        assert len([i for i in issues if i.check == "duty_on_leave"]) == 2


class TestTemplateDoctorActive:
    def test_inactive_doctor_referenced_by_template_is_error(self, session, config_1wk):
        t = make_template(session, is_active=True)
        d = make_doctor(session, code="ZZ", active=False)
        make_master_session(session, t, d, week=1, day=Day.MONDAY, period=Period.AM)

        ctx = load_context(session, config_1wk)
        issues = run_phase0(ctx, config_1wk)

        assert any(i.check == "template_doctor_active" for i in _errors(issues))

    def test_active_doctor_referenced_by_template_no_error(self, session, config_1wk):
        t = make_template(session, is_active=True)
        d = make_doctor(session, code="AA", active=True)
        make_master_session(session, t, d, week=1, day=Day.MONDAY, period=Period.AM)

        ctx = load_context(session, config_1wk)
        issues = run_phase0(ctx, config_1wk)

        assert not any(i.check == "template_doctor_active" for i in issues)

    def test_inactive_doctor_flagged_once_across_multiple_slots(self, session, config_1wk):
        t = make_template(session, is_active=True)
        d = make_doctor(session, code="ZZ", active=False)
        make_master_session(session, t, d, week=1, day=Day.MONDAY, period=Period.AM)
        make_master_session(session, t, d, week=1, day=Day.MONDAY, period=Period.PM)
        make_master_session(session, t, d, week=2, day=Day.TUESDAY, period=Period.AM)

        ctx = load_context(session, config_1wk)
        issues = run_phase0(ctx, config_1wk)

        matching = [i for i in issues if i.check == "template_doctor_active"]
        assert len(matching) == 1

    def test_no_template_sessions_no_error(self, session, config_1wk):
        make_template(session, is_active=True)  # no MasterRotaSession rows at all
        ctx = load_context(session, config_1wk)
        issues = run_phase0(ctx, config_1wk)
        assert not any(i.check == "template_doctor_active" for i in issues)


class TestHappyPath:
    def test_no_errors_on_valid_setup(self, session, config_1wk):
        t = make_template(session, is_active=True)
        d = make_doctor(session, code="AA", active=True)
        make_master_session(session, t, d, week=1, day=Day.MONDAY, period=Period.AM)

        ctx = load_context(session, config_1wk)
        issues = run_phase0(ctx, config_1wk)

        assert _errors(issues) == []