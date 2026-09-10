from app.engine.context import load_context
from app.engine.phases.phase2 import run_phase2
from app.engine.phases.phase4 import run_phase4
from app.engine.phases.phase12 import run_phase12
from app.engine.datatypes import DecisionLog
from app.models.enums import (
    Day, DoctorType, DutyType, MasterSessionType, Period, RoomType, SessionRole,
)

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
    return ctx, grid, counters


class TestDutyCoverage:
    def test_missing_monday_primary_warns(self, session, config_1wk):
        t = make_template(session, is_active=True)
        d = make_doctor(session, code="AA")
        make_master_session(
            session, t, d, week=1, day=Day.MONDAY, period=Period.AM,
            session_type=MasterSessionType.REQUIRES_ROOM,
        )
        # no DutyAssignment at all -- expected 1 primary Monday AM, found 0

        ctx, grid, counters = _build(session, config_1wk)
        issues = run_phase12(ctx, grid)

        matching = [i for i in issues if i.check == "duty_coverage_primary"
                    and i.day == Day.MONDAY and i.period == Period.AM]
        assert len(matching) == 1
        assert "expected 1" in matching[0].message

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

        ctx, grid, counters = _build(session, config_1wk)
        log = DecisionLog()
        run_phase4(ctx, grid, counters, log)
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
        ctx, grid, counters = _build(session, config_1wk)
        issues = run_phase12(ctx, grid)

        primary_issue = next(
            i for i in issues if i.check == "duty_coverage_primary"
            and i.day == Day.TUESDAY and i.period == Period.AM
        )
        assert "expected 1" in primary_issue.message
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

        ctx, grid, counters = _build(session, config_1wk)
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

        ctx, grid, counters = _build(session, config_1wk)
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

        ctx, grid, counters = _build(session, config_1wk)
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
        ctx, grid, counters = _build(session, config_1wk)
        issues = run_phase12(ctx, grid)

        assert any(i.check == "unresolved_room" for i in issues)

    def test_unresolved_room_carries_the_doctor_id(self, session, config_1wk):
        """The frontend grid rings the offending cell off `doctor_id`, so the
        finding has to name the doctor structurally, not only in `message`."""
        t = make_template(session, is_active=True)
        d = make_doctor(session, code="AA")
        make_master_session(
            session, t, d, week=1, day=Day.MONDAY, period=Period.AM,
            session_type=MasterSessionType.REQUIRES_ROOM,
        )
        ctx, grid, counters = _build(session, config_1wk)
        issues = run_phase12(ctx, grid)

        matching = [i for i in issues if i.check == "unresolved_room"]
        assert len(matching) == 1
        assert matching[0].doctor_id == d.id

    def test_resolved_requires_room_no_warning(self, session, config_1wk):
        t = make_template(session, is_active=True)
        d = make_doctor(session, code="AA")
        room = make_room(session, code="D1", room_type=RoomType.D)
        make_master_session(
            session, t, d, week=1, day=Day.MONDAY, period=Period.AM,
            session_type=MasterSessionType.PRE_ASSIGNED, room=room,
        )
        ctx, grid, counters = _build(session, config_1wk)
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

        ctx, grid, counters = _build(session, config_1wk)
        issues = run_phase12(ctx, grid)

        assert not any(i.check == "unresolved_room" for i in issues)


class TestRoleOnIncompatibleSlot:
    """M3.7: any role (duty or clinic) landing on a NO_SURGERY/ADMIN_TIME
    template slot, an on-leave slot, or a WFH slot warns. Covers both
    generation output and post-generation edits, since swap/move/PATCH all
    re-run this same check via grid_utils with no eligibility checks of
    their own upstream.
    """

    def test_role_on_no_surgery_warns(self, session, config_1wk):
        t = make_template(session, is_active=True)
        d = make_doctor(session, code="AA")
        make_master_session(
            session, t, d, week=1, day=Day.MONDAY, period=Period.AM,
            session_type=MasterSessionType.NO_SURGERY,
        )
        ctx, grid, counters = _build(session, config_1wk)
        grid.get(d.id, 1, Day.MONDAY, Period.AM).role = SessionRole.DUTY_PRIMARY
        issues = run_phase12(ctx, grid)

        assert any(i.check == "role_on_incompatible_slot" for i in issues)

    def test_role_on_admin_time_warns(self, session, config_1wk):
        t = make_template(session, is_active=True)
        d = make_doctor(session, code="AA")
        make_master_session(
            session, t, d, week=1, day=Day.MONDAY, period=Period.AM,
            session_type=MasterSessionType.ADMIN_TIME,
        )
        ctx, grid, counters = _build(session, config_1wk)
        # Clinic role too, not just duty - M3.7 covers any role.
        grid.get(d.id, 1, Day.MONDAY, Period.AM).role = SessionRole.CLINIC
        issues = run_phase12(ctx, grid)

        assert any(i.check == "role_on_incompatible_slot" for i in issues)

    def test_role_on_leave_warns(self, session, config_1wk, monday):
        t = make_template(session, is_active=True)
        d = make_doctor(session, code="AA")
        make_master_session(
            session, t, d, week=1, day=Day.MONDAY, period=Period.AM,
            session_type=MasterSessionType.REQUIRES_ROOM,
        )
        make_leave(session, d, monday, Period.AM)
        ctx, grid, counters = _build(session, config_1wk)
        grid.get(d.id, 1, Day.MONDAY, Period.AM).role = SessionRole.DUTY_PRIMARY
        issues = run_phase12(ctx, grid)

        assert any(i.check == "role_on_incompatible_slot" for i in issues)

    def test_role_on_wfh_warns(self, session, config_1wk):
        t = make_template(session, is_active=True)
        d = make_doctor(session, code="AA")
        make_master_session(
            session, t, d, week=1, day=Day.MONDAY, period=Period.AM,
            session_type=MasterSessionType.WFH,
        )
        ctx, grid, counters = _build(session, config_1wk)
        grid.get(d.id, 1, Day.MONDAY, Period.AM).role = SessionRole.DUTY_PRIMARY
        issues = run_phase12(ctx, grid)

        assert any(i.check == "role_on_incompatible_slot" for i in issues)

    def test_role_on_normal_slot_does_not_warn(self, session, config_1wk):
        t = make_template(session, is_active=True)
        d = make_doctor(session, code="AA")
        make_master_session(
            session, t, d, week=1, day=Day.MONDAY, period=Period.AM,
            session_type=MasterSessionType.REQUIRES_ROOM,
        )
        ctx, grid, counters = _build(session, config_1wk)
        grid.get(d.id, 1, Day.MONDAY, Period.AM).role = SessionRole.DUTY_PRIMARY
        issues = run_phase12(ctx, grid)

        assert not any(i.check == "role_on_incompatible_slot" for i in issues)

    def test_normal_slot_with_no_role_does_not_warn(self, session, config_1wk):
        t = make_template(session, is_active=True)
        d = make_doctor(session, code="AA")
        make_master_session(
            session, t, d, week=1, day=Day.MONDAY, period=Period.AM,
            session_type=MasterSessionType.NO_SURGERY,
        )
        ctx, grid, counters = _build(session, config_1wk)
        issues = run_phase12(ctx, grid)

        assert not any(i.check == "role_on_incompatible_slot" for i in issues)


class TestRoomOnLeaveSlot:
    """Generation never produces this state (Phase 2 skips the occupancy
    claim for on-leave slots), so these tests force the room onto the slot
    directly via grid.assign_room() -- simulating the post-hoc leave /
    rollback / forced-edit paths that this check exists to catch."""

    def test_room_on_leave_slot_warns(self, session, config_1wk, monday):
        t = make_template(session, is_active=True)
        d = make_doctor(session, code="AA")
        room = make_room(session, code="D1", room_type=RoomType.D)
        make_master_session(
            session, t, d, week=1, day=Day.MONDAY, period=Period.AM,
            session_type=MasterSessionType.REQUIRES_ROOM,
        )
        make_leave(session, d, monday, Period.AM)

        ctx, grid, counters = _build(session, config_1wk)
        grid.assign_room(1, Day.MONDAY, Period.AM, d.id, room.id)
        issues = run_phase12(ctx, grid)

        matching = [i for i in issues if i.check == "room_on_leave_slot"]
        assert len(matching) == 1
        assert "AA" in matching[0].message
        assert "D1" in matching[0].message

    def test_room_on_leave_slot_with_role_also_warns_both(self, session, config_1wk, monday):
        """Pins the deliberate co-firing: a leave slot holding both a room
        and a role produces room_on_leave_slot AND role_on_incompatible_slot
        -- two distinct true findings, not a duplicate."""
        t = make_template(session, is_active=True)
        d = make_doctor(session, code="AA")
        room = make_room(session, code="D1", room_type=RoomType.D)
        make_master_session(
            session, t, d, week=1, day=Day.MONDAY, period=Period.AM,
            session_type=MasterSessionType.REQUIRES_ROOM,
        )
        make_leave(session, d, monday, Period.AM)

        ctx, grid, counters = _build(session, config_1wk)
        grid.assign_room(1, Day.MONDAY, Period.AM, d.id, room.id)
        grid.get(d.id, 1, Day.MONDAY, Period.AM).role = SessionRole.DUTY_PRIMARY
        issues = run_phase12(ctx, grid)

        assert any(i.check == "room_on_leave_slot" for i in issues)
        assert any(i.check == "role_on_incompatible_slot" for i in issues)

    def test_leave_slot_without_room_does_not_warn(self, session, config_1wk, monday):
        t = make_template(session, is_active=True)
        d = make_doctor(session, code="AA")
        make_master_session(
            session, t, d, week=1, day=Day.MONDAY, period=Period.AM,
            session_type=MasterSessionType.REQUIRES_ROOM,
        )
        make_leave(session, d, monday, Period.AM)

        ctx, grid, counters = _build(session, config_1wk)
        issues = run_phase12(ctx, grid)

        assert not any(i.check == "room_on_leave_slot" for i in issues)