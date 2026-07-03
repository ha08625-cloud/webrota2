from app.engine.context import load_context
from app.engine.phases.phase2 import run_phase2
from app.engine.phases.phase4 import run_phase4
from app.engine.phases.phase12 import run_phase12
from app.models.enums import Day, DoctorType, DutyType, MasterSessionType, Period, RoomType

from .factories import (
    make_clinic_type,
    make_doctor,
    make_duty,
    make_leave,
    make_master_session,
    make_room,
    make_template,
)


def _build(session, config):
    ctx = load_context(session, config)
    grid, counters = run_phase2(ctx, config, session)
    return ctx, grid


class TestDutyCoverage:
    def test_missing_monday_primary_warns(self, session, config_1wk):
        t = make_template(session, is_active=True)
        d = make_doctor(session, code="AA")
        make_master_session(
            session, t, d, week=1, day=Day.MONDAY, period=Period.AM,
            session_type=MasterSessionType.REQUIRES_ROOM,
        )
        # no DutyAssignment at all -- expected 1 primary Monday AM, found 0

        ctx, grid = _build(session, config_1wk)
        issues = run_phase12(ctx, grid)

        matching = [i for i in issues if i.check == "duty_coverage_primary"
                    and i.day == Day.MONDAY and i.period == Period.AM]
        assert len(matching) == 1
        assert "Expected 1" in matching[0].message

    def test_correct_monday_coverage_no_warning(self, session, config_1wk, monday):
        t = make_template(session, is_active=True)
        d1 = make_doctor(session, code="AA")
        d2 = make_doctor(session, code="BB")
        for d in (d1, d2):
            make_master_session(
                session, t, d, week=1, day=Day.MONDAY, period=Period.AM,
                session_type=MasterSessionType.REQUIRES_ROOM,
            )
        # DutyAssignment schema is unique on (date, period, duty_type) --
        # at most 1 primary and 1 secondary can ever exist per session.
        make_duty(session, monday, Period.AM, d1, DutyType.PRIMARY)
        make_duty(session, monday, Period.AM, d2, DutyType.SECONDARY)

        ctx, grid = _build(session, config_1wk)
        run_phase4(ctx, grid)
        issues = run_phase12(ctx, grid)

        assert not any(
            i.check in ("duty_coverage_primary", "duty_coverage_secondary")
            and i.day == Day.MONDAY and i.period == Period.AM
            for i in issues
        )

    def test_tuesday_expects_one_primary_zero_secondary(self, session, config_1wk):
        t = make_template(session, is_active=True)
        d = make_doctor(session, code="AA")
        make_master_session(
            session, t, d, week=1, day=Day.TUESDAY, period=Period.AM,
            session_type=MasterSessionType.REQUIRES_ROOM,
        )
        ctx, grid = _build(session, config_1wk)
        issues = run_phase12(ctx, grid)

        primary_issue = next(
            i for i in issues if i.check == "duty_coverage_primary"
            and i.day == Day.TUESDAY and i.period == Period.AM
        )
        assert "Expected 1" in primary_issue.message
        # no secondary warning on Tuesday since expected=0 and found=0
        assert not any(
            i.check == "duty_coverage_secondary" and i.day == Day.TUESDAY and i.period == Period.AM
            for i in issues
        )

    def test_two_primary_same_session_impossible_at_db_level(self, session, config_1wk, monday):
        """Documents the constraint that made the original Check 1 wording
        ("2 primary Monday") impossible: DutyAssignment is unique on
        (date, period, duty_type), so a second PRIMARY row for the same
        date/period always fails at the database, before Phase 12 even
        runs. make_duty() flushes internally, so the second call itself is
        where the IntegrityError is raised -- not a separate flush() after
        it."""
        import pytest
        from sqlalchemy.exc import IntegrityError

        t = make_template(session, is_active=True)
        d1 = make_doctor(session, code="AA")
        d2 = make_doctor(session, code="BB")
        make_duty(session, monday, Period.AM, d1, DutyType.PRIMARY)
        with pytest.raises(IntegrityError):
            make_duty(session, monday, Period.AM, d2, DutyType.PRIMARY)


class TestClinicCoverage:
    def test_zero_assignments_warns(self, session, config_1wk):
        t = make_template(session, is_active=True)
        d = make_doctor(session, code="AA")
        make_master_session(
            session, t, d, week=1, day=Day.MONDAY, period=Period.AM,
            session_type=MasterSessionType.REQUIRES_ROOM,
        )
        make_clinic_type(
            session, name="Dragon", room_required=False,
            schedules=[(Day.MONDAY, Period.AM)], doctor_eligibilities=[(d.id, 1)],
        )

        ctx, grid = _build(session, config_1wk)
        # phase5 not run -- clinic_type_id never set
        issues = run_phase12(ctx, grid)

        matching = [i for i in issues if i.check == "clinic_coverage"]
        assert len(matching) == 1
        assert "found 0" in matching[0].message

    def test_exactly_one_assignment_no_warning(self, session, config_1wk):
        t = make_template(session, is_active=True)
        d = make_doctor(session, code="AA")
        make_master_session(
            session, t, d, week=1, day=Day.MONDAY, period=Period.AM,
            session_type=MasterSessionType.REQUIRES_ROOM,
        )
        ct = make_clinic_type(
            session, name="Dragon", room_required=False,
            schedules=[(Day.MONDAY, Period.AM)], doctor_eligibilities=[(d.id, 1)],
        )

        ctx, grid = _build(session, config_1wk)
        # manually simulate what phase5 would have done
        grid.get(d.id, 1, Day.MONDAY, Period.AM).clinic_type_id = ct.id
        issues = run_phase12(ctx, grid)

        assert not any(i.check == "clinic_coverage" for i in issues)

    def test_more_than_one_assignment_warns(self, session, config_1wk):
        t = make_template(session, is_active=True)
        d1 = make_doctor(session, code="AA")
        d2 = make_doctor(session, code="BB")
        for d in (d1, d2):
            make_master_session(
                session, t, d, week=1, day=Day.MONDAY, period=Period.AM,
                session_type=MasterSessionType.REQUIRES_ROOM,
            )
        ct = make_clinic_type(
            session, name="Dragon", room_required=False,
            schedules=[(Day.MONDAY, Period.AM)],
            doctor_eligibilities=[(d1.id, 1), (d2.id, 1)],
        )

        ctx, grid = _build(session, config_1wk)
        # simulate a bug where both doctors ended up assigned
        grid.get(d1.id, 1, Day.MONDAY, Period.AM).clinic_type_id = ct.id
        grid.get(d2.id, 1, Day.MONDAY, Period.AM).clinic_type_id = ct.id
        issues = run_phase12(ctx, grid)

        matching = [i for i in issues if i.check == "clinic_coverage"]
        assert len(matching) == 1
        assert "found 2" in matching[0].message


class TestUnresolvedRooms:
    def test_unresolved_requires_room_warns(self, session, config_1wk):
        t = make_template(session, is_active=True)
        d = make_doctor(session, code="AA")
        make_master_session(
            session, t, d, week=1, day=Day.MONDAY, period=Period.AM,
            session_type=MasterSessionType.REQUIRES_ROOM,
        )
        ctx, grid = _build(session, config_1wk)
        issues = run_phase12(ctx, grid)

        assert any(i.check == "unresolved_room" for i in issues)

    def test_resolved_requires_room_no_warning(self, session, config_1wk):
        t = make_template(session, is_active=True)
        d = make_doctor(session, code="AA")
        room = make_room(session, code="D1", room_type=RoomType.D)
        make_master_session(
            session, t, d, week=1, day=Day.MONDAY, period=Period.AM,
            session_type=MasterSessionType.PRE_ASSIGNED, room=room,
        )
        ctx, grid = _build(session, config_1wk)
        # PRE_ASSIGNED isn't REQUIRES_ROOM by definition, so exercise the
        # actual check condition directly: a REQUIRES_ROOM slot that DOES
        # have a room assigned.
        grid.get(d.id, 1, Day.MONDAY, Period.AM).template_type = MasterSessionType.REQUIRES_ROOM
        issues = run_phase12(ctx, grid)

        assert not any(i.check == "unresolved_room" for i in issues)

    def test_on_leave_unresolved_room_does_not_warn(self, session, config_1wk, monday):
        """The key gap flagged back in step 7: an on-leave REQUIRES_ROOM slot
        never gets a room and must NOT be treated as a Check 3 violation."""
        t = make_template(session, is_active=True)
        d = make_doctor(session, code="AA")
        make_master_session(
            session, t, d, week=1, day=Day.MONDAY, period=Period.AM,
            session_type=MasterSessionType.REQUIRES_ROOM,
        )
        make_leave(session, d, monday, Period.AM)

        ctx, grid = _build(session, config_1wk)
        issues = run_phase12(ctx, grid)

        assert not any(i.check == "unresolved_room" for i in issues)
