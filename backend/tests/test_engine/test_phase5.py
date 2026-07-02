from app.engine.context import load_context
from app.engine.phases.phase2 import run_phase2
from app.engine.phases.phase4 import run_phase4
from app.engine.phases.phase5 import run_phase5
from app.models.enums import Day, DutyType, MasterSessionType, Period, RoomType, SessionRole

from .factories import (
    make_clinic_counter,
    make_clinic_type,
    make_doctor,
    make_duty,
    make_leave,
    make_master_session,
    make_preferred_room,
    make_room,
    make_template,
)


def _build(session, config):
    ctx = load_context(session, config)
    grid, counters = run_phase2(ctx, config, session)
    return ctx, grid, counters


def _req_room(session, template, doctor, week=1, day=Day.MONDAY, period=Period.AM):
    make_master_session(
        session, template, doctor, week=week, day=day, period=period,
        session_type=MasterSessionType.REQUIRES_ROOM,
    )


class TestDoctorSelection:
    def test_doctor_priority_wins_over_counter(self, session, config_1wk):
        t = make_template(session, is_active=True)
        preferred = make_doctor(session, code="ZZ")  # alphabetically last, but priority 1
        other = make_doctor(session, code="AA")
        _req_room(session, t, preferred)
        _req_room(session, t, other)
        make_clinic_type(
            session, name="Dragon", room_required=False,
            schedules=[(Day.MONDAY, Period.AM)],
            doctor_eligibilities=[(preferred.id, 1), (other.id, 2)],
        )

        ctx, grid, counters = _build(session, config_1wk)
        run_phase5(ctx, grid, counters)

        slot = grid.get(preferred.id, 1, Day.MONDAY, Period.AM)
        assert slot.role == SessionRole.CLINIC
        assert grid.get(other.id, 1, Day.MONDAY, Period.AM).role is None

    def test_weighted_counter_breaks_priority_tie(self, session, config_1wk):
        t = make_template(session, is_active=True)
        low_count = make_doctor(session, code="ZZ", spw="10.0")
        high_count = make_doctor(session, code="AA", spw="10.0")
        _req_room(session, t, low_count)
        _req_room(session, t, high_count)
        ct = make_clinic_type(
            session, name="Dragon", room_required=False,
            schedules=[(Day.MONDAY, Period.AM)],
            doctor_eligibilities=[(low_count.id, 1), (high_count.id, 1)],
        )
        make_clinic_counter(session, high_count, ct, raw_count=5)  # weighted 0.5
        make_clinic_counter(session, low_count, ct, raw_count=1)   # weighted 0.1

        ctx, grid, counters = _build(session, config_1wk)
        run_phase5(ctx, grid, counters)

        assert grid.get(low_count.id, 1, Day.MONDAY, Period.AM).role == SessionRole.CLINIC
        assert grid.get(high_count.id, 1, Day.MONDAY, Period.AM).role is None

    def test_alphabetical_breaks_full_tie(self, session, config_1wk):
        t = make_template(session, is_active=True)
        d_aa = make_doctor(session, code="AA")
        d_bb = make_doctor(session, code="BB")
        _req_room(session, t, d_aa)
        _req_room(session, t, d_bb)
        make_clinic_type(
            session, name="Dragon", room_required=False,
            schedules=[(Day.MONDAY, Period.AM)],
            doctor_eligibilities=[(d_bb.id, 1), (d_aa.id, 1)],
        )

        ctx, grid, counters = _build(session, config_1wk)
        run_phase5(ctx, grid, counters)

        assert grid.get(d_aa.id, 1, Day.MONDAY, Period.AM).role == SessionRole.CLINIC
        assert grid.get(d_bb.id, 1, Day.MONDAY, Period.AM).role is None

    def test_clinic_counter_incremented(self, session, config_1wk):
        t = make_template(session, is_active=True)
        d = make_doctor(session, code="AA")
        _req_room(session, t, d)
        ct = make_clinic_type(
            session, name="Dragon", room_required=False,
            schedules=[(Day.MONDAY, Period.AM)],
            doctor_eligibilities=[(d.id, 1)],
        )

        ctx, grid, counters = _build(session, config_1wk)
        run_phase5(ctx, grid, counters)

        assert counters.clinic[(d.id, ct.id)] == 1


class TestEligibilityExclusions:
    def test_on_leave_excluded(self, session, config_1wk, monday):
        t = make_template(session, is_active=True)
        d = make_doctor(session, code="AA")
        _req_room(session, t, d)
        make_leave(session, d, monday, Period.AM)
        make_clinic_type(
            session, name="Dragon", room_required=False,
            schedules=[(Day.MONDAY, Period.AM)],
            doctor_eligibilities=[(d.id, 1)],
        )

        ctx, grid, counters = _build(session, config_1wk)
        issues = run_phase5(ctx, grid, counters)

        assert grid.get(d.id, 1, Day.MONDAY, Period.AM).role is None
        assert any(i.check == "no_eligible_doctor" for i in issues)

    def test_wfh_excluded(self, session, config_1wk):
        t = make_template(session, is_active=True)
        d = make_doctor(session, code="AA")
        make_master_session(
            session, t, d, week=1, day=Day.MONDAY, period=Period.AM,
            session_type=MasterSessionType.WFH,
        )
        make_clinic_type(
            session, name="Dragon", room_required=False,
            schedules=[(Day.MONDAY, Period.AM)],
            doctor_eligibilities=[(d.id, 1)],
        )

        ctx, grid, counters = _build(session, config_1wk)
        issues = run_phase5(ctx, grid, counters)

        assert any(i.check == "no_eligible_doctor" for i in issues)

    def test_no_surgery_excluded(self, session, config_1wk):
        t = make_template(session, is_active=True)
        d = make_doctor(session, code="AA")
        make_master_session(
            session, t, d, week=1, day=Day.MONDAY, period=Period.AM,
            session_type=MasterSessionType.NO_SURGERY,
        )
        make_clinic_type(
            session, name="Dragon", room_required=False,
            schedules=[(Day.MONDAY, Period.AM)],
            doctor_eligibilities=[(d.id, 1)],
        )

        ctx, grid, counters = _build(session, config_1wk)
        issues = run_phase5(ctx, grid, counters)

        assert any(i.check == "no_eligible_doctor" for i in issues)

    def test_duty_holder_excluded(self, session, config_1wk, monday):
        t = make_template(session, is_active=True)
        d = make_doctor(session, code="AA")
        _req_room(session, t, d)
        make_duty(session, monday, Period.AM, d, DutyType.PRIMARY)
        make_clinic_type(
            session, name="Dragon", room_required=False,
            schedules=[(Day.MONDAY, Period.AM)],
            doctor_eligibilities=[(d.id, 1)],
        )

        ctx = load_context(session, config_1wk)
        grid, counters = run_phase2(ctx, config_1wk, session)
        run_phase4(ctx, grid)  # apply duty role BEFORE phase5
        issues = run_phase5(ctx, grid, counters)

        slot = grid.get(d.id, 1, Day.MONDAY, Period.AM)
        assert slot.role == SessionRole.DUTY_PRIMARY  # unchanged by phase5
        assert any(i.check == "no_eligible_doctor" for i in issues)


class TestRoomRequired:
    def test_free_eligible_room_assigned(self, session, config_1wk):
        t = make_template(session, is_active=True)
        d = make_doctor(session, code="AA")
        room = make_room(session, code="D1", room_type=RoomType.D)
        _req_room(session, t, d)
        make_clinic_type(
            session, name="Dragon", room_required=True,
            schedules=[(Day.MONDAY, Period.AM)],
            doctor_eligibilities=[(d.id, 1)], room_ids=[room.id],
        )

        ctx, grid, counters = _build(session, config_1wk)
        issues = run_phase5(ctx, grid, counters)

        slot = grid.get(d.id, 1, Day.MONDAY, Period.AM)
        assert slot.assigned_room_id == room.id
        assert not any(i.check == "clinic_room_unresolved" for i in issues)

    def test_already_in_eligible_room_untouched(self, session, config_1wk):
        t = make_template(session, is_active=True)
        d = make_doctor(session, code="AA")
        room = make_room(session, code="D1", room_type=RoomType.D)
        make_master_session(
            session, t, d, week=1, day=Day.MONDAY, period=Period.AM,
            session_type=MasterSessionType.PRE_ASSIGNED, room=room,
        )
        make_clinic_type(
            session, name="Dragon", room_required=True,
            schedules=[(Day.MONDAY, Period.AM)],
            doctor_eligibilities=[(d.id, 1)], room_ids=[room.id],
        )

        ctx, grid, counters = _build(session, config_1wk)
        run_phase5(ctx, grid, counters)

        slot = grid.get(d.id, 1, Day.MONDAY, Period.AM)
        assert slot.assigned_room_id == room.id

    def test_unresolved_room_leaves_doctor_in_current_room_and_warns(self, session, config_1wk):
        t = make_template(session, is_active=True)
        clinic_doctor = make_doctor(session, code="AA")
        occupant = make_doctor(session, code="BB")
        eligible_room = make_room(session, code="D1", room_type=RoomType.D)

        _req_room(session, t, clinic_doctor)
        make_master_session(
            session, t, occupant, week=1, day=Day.MONDAY, period=Period.AM,
            session_type=MasterSessionType.PRE_ASSIGNED, room=eligible_room,
        )
        make_clinic_type(
            session, name="Dragon", room_required=True,
            schedules=[(Day.MONDAY, Period.AM)],
            doctor_eligibilities=[(clinic_doctor.id, 1)], room_ids=[eligible_room.id],
        )

        ctx, grid, counters = _build(session, config_1wk)
        # Simulate the occupant being on leave (equivalent to a LeaveEntry for
        # this date/period), so the only eligible room is protected from
        # displacement.
        grid.get(occupant.id, 1, Day.MONDAY, Period.AM).is_on_leave = True

        issues = run_phase5(ctx, grid, counters)

        clinic_slot = grid.get(clinic_doctor.id, 1, Day.MONDAY, Period.AM)
        assert clinic_slot.assigned_room_id is None  # left in current (no) room
        assert grid.get(occupant.id, 1, Day.MONDAY, Period.AM).assigned_room_id == eligible_room.id
        assert any(i.check == "clinic_room_unresolved" for i in issues)


class TestDisplacement:
    def test_displaces_unprotected_occupant_to_preferred_room(self, session, config_1wk):
        t = make_template(session, is_active=True)
        clinic_doctor = make_doctor(session, code="AA")
        occupant = make_doctor(session, code="BB")
        eligible_room = make_room(session, code="D1", room_type=RoomType.D)
        fallback_room = make_room(session, code="C1", room_type=RoomType.C)

        _req_room(session, t, clinic_doctor)
        make_master_session(
            session, t, occupant, week=1, day=Day.MONDAY, period=Period.AM,
            session_type=MasterSessionType.PRE_ASSIGNED, room=eligible_room,
        )
        make_preferred_room(session, occupant, preference_order=1, room=fallback_room)

        make_clinic_type(
            session, name="Dragon", room_required=True,
            schedules=[(Day.MONDAY, Period.AM)],
            doctor_eligibilities=[(clinic_doctor.id, 1)], room_ids=[eligible_room.id],
        )

        ctx, grid, counters = _build(session, config_1wk)
        issues = run_phase5(ctx, grid, counters)

        assert grid.get(clinic_doctor.id, 1, Day.MONDAY, Period.AM).assigned_room_id == eligible_room.id
        assert grid.get(occupant.id, 1, Day.MONDAY, Period.AM).assigned_room_id == fallback_room.id
        assert not any(i.check == "clinic_room_unresolved" for i in issues)

    def test_displacement_skips_d_room_preference_when_freeing_a_d_room(self, session, config_1wk):
        t = make_template(session, is_active=True)
        clinic_doctor = make_doctor(session, code="AA")
        occupant = make_doctor(session, code="BB")
        eligible_room = make_room(session, code="D1", room_type=RoomType.D)
        other_d_room = make_room(session, code="D2", room_type=RoomType.D)
        c_room = make_room(session, code="C1", room_type=RoomType.C)

        _req_room(session, t, clinic_doctor)
        make_master_session(
            session, t, occupant, week=1, day=Day.MONDAY, period=Period.AM,
            session_type=MasterSessionType.PRE_ASSIGNED, room=eligible_room,
        )
        # occupant prefers another D room first, then a C room
        make_preferred_room(session, occupant, preference_order=1, room=other_d_room)
        make_preferred_room(session, occupant, preference_order=2, room=c_room)

        make_clinic_type(
            session, name="Dragon", room_required=True,
            schedules=[(Day.MONDAY, Period.AM)],
            doctor_eligibilities=[(clinic_doctor.id, 1)], room_ids=[eligible_room.id],
        )

        ctx, grid, counters = _build(session, config_1wk)
        run_phase5(ctx, grid, counters)

        # The D-room preference must be skipped -- occupant lands in the C room.
        assert grid.get(occupant.id, 1, Day.MONDAY, Period.AM).assigned_room_id == c_room.id

    def test_higher_priority_occupant_is_protected(self, session, config_1wk):
        t = make_template(session, is_active=True)
        protected_doctor = make_doctor(session, code="AA")
        challenger_doctor = make_doctor(session, code="BB")
        shared_room = make_room(session, code="D1", room_type=RoomType.D)

        _req_room(session, t, protected_doctor)
        _req_room(session, t, challenger_doctor)

        # Clinic priority 5 (higher priority, processed first) claims the room.
        make_clinic_type(
            session, name="HighPriorityClinic", clinic_priority=5, room_required=True,
            schedules=[(Day.MONDAY, Period.AM)],
            doctor_eligibilities=[(protected_doctor.id, 1)], room_ids=[shared_room.id],
        )
        # Clinic priority 10 (lower priority, processed second) wants the same room.
        make_clinic_type(
            session, name="LowPriorityClinic", clinic_priority=10, room_required=True,
            schedules=[(Day.MONDAY, Period.AM)],
            doctor_eligibilities=[(challenger_doctor.id, 1)], room_ids=[shared_room.id],
        )

        ctx, grid, counters = _build(session, config_1wk)
        issues = run_phase5(ctx, grid, counters)

        assert grid.get(protected_doctor.id, 1, Day.MONDAY, Period.AM).assigned_room_id == shared_room.id
        assert grid.get(challenger_doctor.id, 1, Day.MONDAY, Period.AM).assigned_room_id is None
        assert any(i.check == "clinic_room_unresolved" for i in issues)


class TestMultiWeekAndIndependentCounters:
    def test_counter_shifts_selection_across_weeks(self, session, config_2wk):
        t = make_template(session, is_active=True)
        d_aa = make_doctor(session, code="AA")
        d_bb = make_doctor(session, code="BB")
        for w in (1, 2):
            _req_room(session, t, d_aa, week=w)
            _req_room(session, t, d_bb, week=w)
        make_clinic_type(
            session, name="Dragon", room_required=False,
            schedules=[(Day.MONDAY, Period.AM)],
            doctor_eligibilities=[(d_aa.id, 1), (d_bb.id, 1)],
        )

        ctx, grid, counters = _build(session, config_2wk)
        run_phase5(ctx, grid, counters)

        # Week 1: tied -> alphabetical -> AA. Week 2: AA now has a higher
        # weighted score, so BB is picked.
        assert grid.get(d_aa.id, 1, Day.MONDAY, Period.AM).role == SessionRole.CLINIC
        assert grid.get(d_bb.id, 1, Day.MONDAY, Period.AM).role is None
        assert grid.get(d_bb.id, 2, Day.MONDAY, Period.AM).role == SessionRole.CLINIC
        assert grid.get(d_aa.id, 2, Day.MONDAY, Period.AM).role is None

    def test_two_clinic_types_have_independent_counters(self, session, config_1wk):
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
        ct_a = make_clinic_type(
            session, name="Dragon", room_required=False,
            schedules=[(Day.MONDAY, Period.AM)], doctor_eligibilities=[(d.id, 1)],
        )
        ct_b = make_clinic_type(
            session, name="College", room_required=False,
            schedules=[(Day.TUESDAY, Period.AM)], doctor_eligibilities=[(d.id, 1)],
        )

        ctx, grid, counters = _build(session, config_1wk)
        run_phase5(ctx, grid, counters)

        assert counters.clinic[(d.id, ct_a.id)] == 1
        assert counters.clinic[(d.id, ct_b.id)] == 1