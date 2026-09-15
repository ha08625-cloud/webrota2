import datetime

from app.engine.context import load_context
from app.engine.generate import generate
from app.engine.phases.phase0 import run_phase0
from app.models import RotaConfig
from app.models.enums import (
    Day,
    DutyType,
    MasterSessionType,
    Period,
    RoomType,
)

from .factories import (
    make_clinic_type,
    make_doctor,
    make_duty,
    make_leave,
    make_master_session,
    make_preferred_room,
    make_room,
    make_template,
)


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


class TestDutyOutsideDoctorDates:
    """Phase 2 builds no
    slot for an out-of-window (doctor, date), so a duty there has nothing to
    attach to -- same tier as duty-on-leave and duty-on-closed-date, not
    Phase 4's duty_no_session_slot warning."""

    def test_duty_before_start_date_is_error(self, session, config_1wk, monday):
        make_template(session, is_active=True)
        d = make_doctor(
            session, code="AA", start_date=monday + datetime.timedelta(days=1)
        )
        make_duty(session, monday, Period.AM, d, DutyType.PRIMARY)

        ctx = load_context(session, config_1wk)
        issues = run_phase0(ctx, config_1wk)

        issue = next(
            i for i in _errors(issues) if i.check == "duty_outside_doctor_dates"
        )
        assert issue.week == 1
        assert issue.day == Day.MONDAY
        assert issue.period == Period.AM
        assert "AA" in issue.message

    def test_duty_after_end_date_is_error(self, session, config_1wk, monday):
        make_template(session, is_active=True)
        wednesday = monday + datetime.timedelta(days=2)
        d = make_doctor(session, code="AA", end_date=monday)
        make_duty(session, wednesday, Period.PM, d, DutyType.PRIMARY)

        ctx = load_context(session, config_1wk)
        issues = run_phase0(ctx, config_1wk)

        assert any(
            i.check == "duty_outside_doctor_dates" for i in _errors(issues)
        )

    def test_duty_inside_window_no_error(self, session, config_1wk, monday):
        make_template(session, is_active=True)
        d = make_doctor(
            session, code="AA", start_date=monday,
            end_date=monday + datetime.timedelta(days=30),
        )
        make_duty(session, monday, Period.AM, d, DutyType.PRIMARY)

        ctx = load_context(session, config_1wk)
        issues = run_phase0(ctx, config_1wk)

        assert not any(i.check == "duty_outside_doctor_dates" for i in issues)

    def test_null_window_no_error(self, session, config_1wk, monday):
        make_template(session, is_active=True)
        d = make_doctor(session, code="AA")
        make_duty(session, monday, Period.AM, d, DutyType.PRIMARY)

        ctx = load_context(session, config_1wk)
        issues = run_phase0(ctx, config_1wk)

        assert not any(i.check == "duty_outside_doctor_dates" for i in issues)

    def test_inactive_doctor_still_reachable(self, session, config_1wk, monday):
        """context.doctor_by_id, not context.doctors -- an inactive doctor
        with a stale duty assignment must still be flagged."""
        make_template(session, is_active=True)
        d = make_doctor(
            session, code="AA", active=False,
            start_date=monday + datetime.timedelta(days=1),
        )
        make_duty(session, monday, Period.AM, d, DutyType.PRIMARY)

        ctx = load_context(session, config_1wk)
        issues = run_phase0(ctx, config_1wk)

        assert any(
            i.check == "duty_outside_doctor_dates" for i in _errors(issues)
        )

    def test_error_aborts_generation(self, session, monday):
        t = make_template(session, is_active=True)
        d = make_doctor(
            session, code="AA", start_date=monday + datetime.timedelta(days=1)
        )
        make_master_session(session, t, d, week=1, day=Day.MONDAY, period=Period.AM)
        make_duty(session, monday, Period.AM, d, DutyType.PRIMARY)
        config = RotaConfig(start_date=monday, num_weeks=1, template_start_week=1)
        session.add(config)
        session.flush()

        result = generate(session, config.id)

        assert result.status == "failed"
        assert result.rota_id is None
        assert any(i.check == "duty_outside_doctor_dates" for i in result.issues)


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

def _warnings(issues):
    return [i for i in issues if i.severity == "warning"]


class TestPreAssignedSrRoom:
    """D7: a template row pre-assigning SR wins outright -- Phase 2 claims
    the room before the reservation Phase 9C relies on can apply. Phase 0
    warns so the admin sees the conflict, and does not block the run.
    """

    def test_pre_assigned_sr_room_warns(self, session, config_1wk):
        t = make_template(session, is_active=True)
        d = make_doctor(session, code="AA")
        sr_room = make_room(session, code="SR1", room_type=RoomType.SR)
        make_master_session(
            session, t, d, week=1, day=Day.MONDAY, period=Period.AM,
            session_type=MasterSessionType.PRE_ASSIGNED, room=sr_room,
        )

        ctx = load_context(session, config_1wk)
        issues = run_phase0(ctx, config_1wk)

        matching = [i for i in _warnings(issues) if i.check == "pre_assigned_sr_room"]
        assert len(matching) == 1
        assert matching[0].doctor_id == d.id
        assert "SR1" in matching[0].message
        # A warning, never an error -- it must not abort the run.
        assert not any(i.check == "pre_assigned_sr_room" for i in _errors(issues))

    def test_pre_assigned_non_sr_room_does_not_warn(self, session, config_1wk):
        t = make_template(session, is_active=True)
        d = make_doctor(session, code="AA")
        d_room = make_room(session, code="D1", room_type=RoomType.D)
        make_master_session(
            session, t, d, week=1, day=Day.MONDAY, period=Period.AM,
            session_type=MasterSessionType.PRE_ASSIGNED, room=d_room,
        )

        ctx = load_context(session, config_1wk)
        issues = run_phase0(ctx, config_1wk)

        assert not any(i.check == "pre_assigned_sr_room" for i in issues)

    def test_pre_assigned_sr_room_does_not_abort_generation(self, session, monday):
        t = make_template(session, is_active=True)
        d = make_doctor(session, code="AA")
        sr_room = make_room(session, code="SR1", room_type=RoomType.SR)
        make_master_session(
            session, t, d, week=1, day=Day.MONDAY, period=Period.AM,
            session_type=MasterSessionType.PRE_ASSIGNED, room=sr_room,
        )
        config = RotaConfig(start_date=monday, num_weeks=1, template_start_week=1)
        session.add(config)
        session.flush()

        result = generate(session, config.id)

        assert result.rota_id is not None
        assert result.status != "failed"
        assert any(i.check == "pre_assigned_sr_room" for i in result.issues)


class TestClinicSrRoomEligibility:
    """The engine does not silently ignore a stored `ClinicTypeRoomEligibility`
    row naming SR -- the clinic-type API rejects new ones, so any that remain
    predate that or were written straight to the database. Phase 0 names them.
    """

    def test_enabled_clinic_type_with_sr_eligibility_warns(self, session, config_1wk):
        make_template(session, is_active=True)
        sr_room = make_room(session, code="SR1", room_type=RoomType.SR)
        make_clinic_type(
            session, name="Dragon", is_enabled=True, room_required=True,
            schedules=[(Day.MONDAY, Period.AM)], room_ids=[sr_room.id],
        )

        ctx = load_context(session, config_1wk)
        issues = run_phase0(ctx, config_1wk)

        matching = [
            i for i in _warnings(issues) if i.check == "clinic_sr_room_eligibility"
        ]
        assert len(matching) == 1
        assert "Dragon" in matching[0].message
        assert "SR1" in matching[0].message

    def test_clinic_type_without_sr_eligibility_does_not_warn(self, session, config_1wk):
        make_template(session, is_active=True)
        c_room = make_room(session, code="C1", room_type=RoomType.C)
        make_clinic_type(
            session, name="Dragon", is_enabled=True, room_required=True,
            schedules=[(Day.MONDAY, Period.AM)], room_ids=[c_room.id],
        )

        ctx = load_context(session, config_1wk)
        issues = run_phase0(ctx, config_1wk)

        assert not any(i.check == "clinic_sr_room_eligibility" for i in issues)

    def test_disabled_clinic_type_with_sr_eligibility_is_silent(self, session, config_1wk):
        # `context.clinic_types` holds enabled clinic types only, so a
        # disabled one carrying a stale row cannot place anyone in SR.
        make_template(session, is_active=True)
        sr_room = make_room(session, code="SR1", room_type=RoomType.SR)
        make_clinic_type(
            session, name="Dragon", is_enabled=False, room_required=True,
            schedules=[(Day.MONDAY, Period.AM)], room_ids=[sr_room.id],
        )

        ctx = load_context(session, config_1wk)
        issues = run_phase0(ctx, config_1wk)

        assert not any(i.check == "clinic_sr_room_eligibility" for i in issues)


class TestPreferredTrRoom:
    """A stored preference is the one path by which a generation phase could
    seat a doctor in a treatment room: Pass 3 of phase7_9a walks the
    preference list with no room-type filter. The doctor API rejects new
    ones, so any that remain predate that check or were written straight to
    the database -- Phase 0 names them rather than `load_context()`
    silently dropping them.
    """

    def test_preferred_tr_room_warns(self, session, config_1wk):
        make_template(session, is_active=True)
        doctor = make_doctor(session, code="AA")
        tr = make_room(session, code="TR1", room_type=RoomType.TR)
        make_preferred_room(session, doctor, 1, room=tr)

        ctx = load_context(session, config_1wk)
        issues = run_phase0(ctx, config_1wk)

        matching = [i for i in _warnings(issues) if i.check == "preferred_tr_room"]
        assert len(matching) == 1
        assert "AA" in matching[0].message
        assert "TR1" in matching[0].message
        assert matching[0].doctor_id == doctor.id
        assert not any(i.check == "preferred_tr_room" for i in _errors(issues))

    def test_a_stored_tr_room_type_token_names_every_tr_room(
        self, session, config_1wk
    ):
        # `preferred_rooms_by_doctor` expands room_type entries to concrete
        # rooms, so a stored token surfaces as the whole set -- which is
        # what it would actually offer the engine.
        make_template(session, is_active=True)
        doctor = make_doctor(session, code="AA")
        make_room(session, code="TR1", room_type=RoomType.TR)
        make_room(session, code="CK", room_type=RoomType.TR)
        make_preferred_room(session, doctor, 1, room_type=RoomType.TR)

        ctx = load_context(session, config_1wk)
        issues = run_phase0(ctx, config_1wk)

        matching = [i for i in _warnings(issues) if i.check == "preferred_tr_room"]
        assert len(matching) == 1
        assert "TR1" in matching[0].message and "CK" in matching[0].message

    def test_non_tr_preferences_do_not_warn(self, session, config_1wk):
        # Guard against the check firing on the ordinary case -- SR is a
        # legitimate preference, unlike a clinic room eligibility.
        make_template(session, is_active=True)
        doctor = make_doctor(session, code="AA")
        d_room = make_room(session, code="D1", room_type=RoomType.D)
        sr_room = make_room(session, code="SR1", room_type=RoomType.SR)
        make_preferred_room(session, doctor, 1, room=d_room)
        make_preferred_room(session, doctor, 2, room=sr_room)

        ctx = load_context(session, config_1wk)
        issues = run_phase0(ctx, config_1wk)

        assert not any(i.check == "preferred_tr_room" for i in issues)

    def test_preferred_tr_room_does_not_abort_generation(self, session, monday):
        t = make_template(session, is_active=True)
        d = make_doctor(session, code="AA")
        tr = make_room(session, code="TR1", room_type=RoomType.TR)
        make_room(session, code="D1", room_type=RoomType.D)
        make_preferred_room(session, d, 1, room=tr)
        make_master_session(
            session, t, d, week=1, day=Day.MONDAY, period=Period.AM,
            session_type=MasterSessionType.REQUIRES_ROOM,
        )
        config = RotaConfig(start_date=monday, num_weeks=1, template_start_week=1)
        session.add(config)
        session.flush()

        result = generate(session, config.id)

        assert result.rota_id is not None
        assert result.status != "failed"
        assert any(i.check == "preferred_tr_room" for i in result.issues)


class TestClinicTrRoomEligibility:
    """The TR counterpart of TestClinicSrRoomEligibility: Phase 5 resolves a
    clinic's room out of `eligible_room_ids` without consulting the room
    type, so a stale row naming TR can still hand a treatment room to a
    clinic even though no phase is allowed to allocate one.
    """

    def test_enabled_clinic_type_with_tr_eligibility_warns(self, session, config_1wk):
        make_template(session, is_active=True)
        tr = make_room(session, code="TR1", room_type=RoomType.TR)
        make_clinic_type(
            session, name="Dragon", is_enabled=True, room_required=True,
            schedules=[(Day.MONDAY, Period.AM)], room_ids=[tr.id],
        )

        ctx = load_context(session, config_1wk)
        issues = run_phase0(ctx, config_1wk)

        matching = [
            i for i in _warnings(issues) if i.check == "clinic_tr_room_eligibility"
        ]
        assert len(matching) == 1
        assert "Dragon" in matching[0].message
        assert "TR1" in matching[0].message

    def test_clinic_type_without_tr_eligibility_does_not_warn(
        self, session, config_1wk
    ):
        make_template(session, is_active=True)
        c_room = make_room(session, code="C1", room_type=RoomType.C)
        make_clinic_type(
            session, name="Dragon", is_enabled=True, room_required=True,
            schedules=[(Day.MONDAY, Period.AM)], room_ids=[c_room.id],
        )

        ctx = load_context(session, config_1wk)
        issues = run_phase0(ctx, config_1wk)

        assert not any(i.check == "clinic_tr_room_eligibility" for i in issues)

    def test_disabled_clinic_type_with_tr_eligibility_is_silent(
        self, session, config_1wk
    ):
        make_template(session, is_active=True)
        tr = make_room(session, code="TR1", room_type=RoomType.TR)
        make_clinic_type(
            session, name="Dragon", is_enabled=False, room_required=True,
            schedules=[(Day.MONDAY, Period.AM)], room_ids=[tr.id],
        )

        ctx = load_context(session, config_1wk)
        issues = run_phase0(ctx, config_1wk)

        assert not any(i.check == "clinic_tr_room_eligibility" for i in issues)
