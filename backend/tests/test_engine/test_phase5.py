from decimal import Decimal

from app.engine.context import load_context
from app.engine.phases.phase2 import run_phase2
from app.engine.phases.phase4 import run_phase4
from app.engine.phases.phase5 import run_phase5
from app.engine.datatypes import DecisionLog
from app.models.enums import Day, DutyType, MasterSessionType, Period, RoomType, SessionRole

from .factories import (
    make_clinic_counter,
    make_clinic_type,
    make_closure,
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
        log = DecisionLog()
        run_phase5(ctx, grid, counters, log)

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
        log = DecisionLog()
        run_phase5(ctx, grid, counters, log)

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
        log = DecisionLog()
        run_phase5(ctx, grid, counters, log)

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
        log = DecisionLog()
        run_phase5(ctx, grid, counters, log)

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
        log = DecisionLog()
        issues = run_phase5(ctx, grid, counters, log)

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
        log = DecisionLog()
        issues = run_phase5(ctx, grid, counters, log)

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
        log = DecisionLog()
        issues = run_phase5(ctx, grid, counters, log)

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
        log = DecisionLog()
        run_phase4(ctx, grid, counters, log)  # apply duty role BEFORE phase5
        issues = run_phase5(ctx, grid, counters, log)

        slot = grid.get(d.id, 1, Day.MONDAY, Period.AM)
        assert slot.role == SessionRole.DUTY_PRIMARY  # unchanged by phase5
        assert any(i.check == "no_eligible_doctor" for i in issues)


class TestRoomResolutionFreeRoom:
    def test_free_room_assigned(self, session, config_1wk):
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
        log = DecisionLog()
        run_phase5(ctx, grid, counters, log)

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

        log = DecisionLog()
        issues = run_phase5(ctx, grid, counters, log)

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
        log = DecisionLog()
        issues = run_phase5(ctx, grid, counters, log)

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
        log = DecisionLog()
        run_phase5(ctx, grid, counters, log)

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
        log = DecisionLog()
        issues = run_phase5(ctx, grid, counters, log)

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
        log = DecisionLog()
        run_phase5(ctx, grid, counters, log)

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
        log = DecisionLog()
        run_phase5(ctx, grid, counters, log)

        assert counters.clinic[(d.id, ct_a.id)] == 1
        assert counters.clinic[(d.id, ct_b.id)] == 1


class TestDecisionLog:
    def test_skip_closed_date_entry(self, session, config_1wk, monday):
        t = make_template(session, is_active=True)
        d = make_doctor(session, code="AA")
        _req_room(session, t, d)
        make_closure(session, monday)
        make_clinic_type(
            session, name="Dragon", room_required=False,
            schedules=[(Day.MONDAY, Period.AM)],
            doctor_eligibilities=[(d.id, 1)],
        )

        ctx, grid, counters = _build(session, config_1wk)
        log = DecisionLog()
        run_phase5(ctx, grid, counters, log)

        skips = [e for e in log.entries if e.action == "skip_closed_date"]
        assert len(skips) == 1
        assert skips[0].phase == "phase5"
        assert skips[0].week == 1
        assert skips[0].day == Day.MONDAY
        assert skips[0].period == Period.AM
        assert skips[0].clinic_type_id is not None
        assert "closed" in skips[0].message.lower()

    def test_assign_clinic_entry_only_eligible_doctor(self, session, config_1wk):
        t = make_template(session, is_active=True)
        d = make_doctor(session, code="AA")
        _req_room(session, t, d)
        ct = make_clinic_type(
            session, name="Dragon", room_required=False,
            schedules=[(Day.MONDAY, Period.AM)],
            doctor_eligibilities=[(d.id, 1)],
        )

        ctx, grid, counters = _build(session, config_1wk)
        log = DecisionLog()
        run_phase5(ctx, grid, counters, log)

        entries = [e for e in log.entries if e.action == "assign_clinic"]
        assert len(entries) == 1
        entry = entries[0]
        assert entry.doctor_id == d.id
        assert entry.clinic_type_id == ct.id
        assert entry.week == 1 and entry.day == Day.MONDAY and entry.period == Period.AM
        assert "AA" in entry.message
        assert "only eligible doctor" in entry.message

    def test_assign_clinic_entry_reports_priority_tier(self, session, config_1wk):
        t = make_template(session, is_active=True)
        preferred = make_doctor(session, code="ZZ")
        other = make_doctor(session, code="AA")
        _req_room(session, t, preferred)
        _req_room(session, t, other)
        make_clinic_type(
            session, name="Dragon", room_required=False,
            schedules=[(Day.MONDAY, Period.AM)],
            doctor_eligibilities=[(preferred.id, 1), (other.id, 2)],
        )

        ctx, grid, counters = _build(session, config_1wk)
        log = DecisionLog()
        run_phase5(ctx, grid, counters, log)

        entry = next(e for e in log.entries if e.action == "assign_clinic")
        assert entry.doctor_id == preferred.id
        assert "priority tier 1" in entry.message

    def test_assign_clinic_entry_reports_weighted_score_tiebreak(self, session, config_1wk):
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
        make_clinic_counter(session, high_count, ct, raw_count=5)
        make_clinic_counter(session, low_count, ct, raw_count=1)

        ctx, grid, counters = _build(session, config_1wk)
        log = DecisionLog()
        run_phase5(ctx, grid, counters, log)

        entry = next(e for e in log.entries if e.action == "assign_clinic")
        assert entry.doctor_id == low_count.id
        assert "tie broken on weighted score" in entry.message

    def test_assign_clinic_room_entry_free_room(self, session, config_1wk):
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
        log = DecisionLog()
        run_phase5(ctx, grid, counters, log)

        entries = [e for e in log.entries if e.action == "assign_clinic_room"]
        assert len(entries) == 1
        assert entries[0].doctor_id == d.id
        assert entries[0].room_id == room.id

    def test_displace_for_clinic_entry(self, session, config_1wk):
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
        ct = make_clinic_type(
            session, name="Dragon", room_required=True,
            schedules=[(Day.MONDAY, Period.AM)],
            doctor_eligibilities=[(clinic_doctor.id, 1)], room_ids=[eligible_room.id],
        )

        ctx, grid, counters = _build(session, config_1wk)
        log = DecisionLog()
        run_phase5(ctx, grid, counters, log)

        entries = [e for e in log.entries if e.action == "displace_for_clinic"]
        assert len(entries) == 1
        entry = entries[0]
        assert entry.doctor_id == clinic_doctor.id
        assert entry.related_doctor_id == occupant.id
        assert entry.room_id == eligible_room.id
        assert entry.related_room_id == fallback_room.id
        assert entry.clinic_type_id == ct.id
        assert "AA" in entry.message and "BB" in entry.message


class TestDecisionLogRationale:
    """The `rationale` field: the stage-by-stage account of *why* a doctor
    was picked, as opposed to `message`'s one-line summary of what happened.

    The point of these tests is that each stage is only narrated when it
    actually ran -- a run whose outcome came from the priority tiers must
    not carry a counter comparison it never made, or the log would be
    unusable for telling the two mechanisms apart.
    """

    def test_lists_the_eligible_field_with_tiers_and_counters(self, session, config_1wk):
        t = make_template(session, is_active=True)
        winner = make_doctor(session, code="AA", spw="10.0")
        loser = make_doctor(session, code="BB", spw="10.0")
        _req_room(session, t, winner)
        _req_room(session, t, loser)
        ct = make_clinic_type(
            session, name="Dragon", room_required=False,
            schedules=[(Day.MONDAY, Period.AM)],
            doctor_eligibilities=[(winner.id, 1), (loser.id, 2)],
        )
        make_clinic_counter(session, winner, ct, raw_count=3)

        ctx, grid, counters = _build(session, config_1wk)
        log = DecisionLog()
        run_phase5(ctx, grid, counters, log)

        entry = next(e for e in log.entries if e.action == "assign_clinic")
        lines = entry.rationale.splitlines()
        # Both doctors appear with the tier and the counter division that
        # produced their score, whichever stage ends up deciding.
        assert lines[0].startswith("Eligible (2):")
        assert "AA (priority tier 1, raw 3 / 10 sessions per week = 0.300)" in lines[0]
        assert "BB (priority tier 2, raw 0 / 10 sessions per week = 0.000)" in lines[0]

    def test_priority_tier_decision_omits_the_counter_stage(self, session, config_1wk):
        t = make_template(session, is_active=True)
        winner = make_doctor(session, code="AA", spw="10.0")
        loser = make_doctor(session, code="BB", spw="10.0")
        _req_room(session, t, winner)
        _req_room(session, t, loser)
        ct = make_clinic_type(
            session, name="Dragon", room_required=False,
            schedules=[(Day.MONDAY, Period.AM)],
            doctor_eligibilities=[(winner.id, 1), (loser.id, 2)],
        )
        # AA has the *worse* counter and still wins: the tier decided, so no
        # counter comparison was made and none may be narrated.
        make_clinic_counter(session, winner, ct, raw_count=9)

        ctx, grid, counters = _build(session, config_1wk)
        log = DecisionLog()
        run_phase5(ctx, grid, counters, log)

        entry = next(e for e in log.entries if e.action == "assign_clinic")
        assert "Top priority tier 1 (1): AA" in entry.rationale
        assert "Weighted clinic counters within that tier" not in entry.rationale
        assert entry.rationale.endswith(
            "Decided on: priority tier -- AA is alone in tier 1."
        )

    def test_counter_decision_shows_the_within_tier_comparison(self, session, config_1wk):
        t = make_template(session, is_active=True)
        low = make_doctor(session, code="ZZ", spw="10.0")
        high = make_doctor(session, code="AA", spw="10.0")
        _req_room(session, t, low)
        _req_room(session, t, high)
        ct = make_clinic_type(
            session, name="Dragon", room_required=False,
            schedules=[(Day.MONDAY, Period.AM)],
            doctor_eligibilities=[(low.id, 1), (high.id, 1)],
        )
        make_clinic_counter(session, high, ct, raw_count=5)
        make_clinic_counter(session, low, ct, raw_count=1)

        ctx, grid, counters = _build(session, config_1wk)
        log = DecisionLog()
        run_phase5(ctx, grid, counters, log)

        entry = next(e for e in log.entries if e.action == "assign_clinic")
        assert "Top priority tier 1 (2):" in entry.rationale
        assert "Weighted clinic counters within that tier (2):" in entry.rationale
        # ZZ wins on the counter despite losing the alphabetical order,
        # which is the distinction the tie-break stages exist to make.
        assert entry.rationale.endswith(
            "Decided on: weighted counter -- ZZ has the lowest weighted count, 0.100."
        )

    def test_opening_balance_decides_and_is_shown_in_the_line(self, session, config_1wk):
        # Two doctors identical on tier, raw count and sessions per week.
        # The joiner's opening balance is the only difference, so it decides
        # -- and the line has to say so, or its stated division (raw 0 / 10)
        # would not produce its stated score.
        t = make_template(session, is_active=True)
        joiner = make_doctor(session, code="AA", spw="10.0")
        peer = make_doctor(session, code="BB", spw="10.0")
        _req_room(session, t, joiner)
        _req_room(session, t, peer)
        ct = make_clinic_type(
            session, name="Dragon", room_required=False,
            schedules=[(Day.MONDAY, Period.AM)],
            doctor_eligibilities=[(joiner.id, 1), (peer.id, 1)],
        )
        make_clinic_counter(
            session, joiner, ct, raw_count=0, opening_balance=Decimal("5.0")
        )
        make_clinic_counter(session, peer, ct, raw_count=0)

        ctx, grid, counters = _build(session, config_1wk)
        log = DecisionLog()
        run_phase5(ctx, grid, counters, log)

        entry = next(e for e in log.entries if e.action == "assign_clinic")
        assert (
            "AA (priority tier 1, raw 0 (+5 opening balance) / 10 sessions "
            "per week = 0.500)" in entry.rationale
        )
        assert "BB (priority tier 1, raw 0 / 10 sessions per week = 0.000)" in entry.rationale
        # BB is picked despite being second alphabetically: the credit put
        # AA behind, which is the whole point of the feature.
        assert entry.rationale.endswith(
            "Decided on: weighted counter -- BB has the lowest weighted count, 0.000."
        )

    def test_alphabetical_decision_is_stated_not_implied(self, session, config_1wk):
        t = make_template(session, is_active=True)
        first = make_doctor(session, code="AA", spw="10.0")
        second = make_doctor(session, code="BB", spw="10.0")
        _req_room(session, t, first)
        _req_room(session, t, second)
        make_clinic_type(
            session, name="Dragon", room_required=False,
            schedules=[(Day.MONDAY, Period.AM)],
            doctor_eligibilities=[(first.id, 1), (second.id, 1)],
        )

        ctx, grid, counters = _build(session, config_1wk)
        log = DecisionLog()
        run_phase5(ctx, grid, counters, log)

        entry = next(e for e in log.entries if e.action == "assign_clinic")
        assert "Still tied on weighted count 0.000 (2): AA; BB" in entry.rationale
        assert entry.rationale.endswith(
            "Decided on: alphabetical order of doctor code (fully tied on every "
            "earlier stage) -- AA."
        )

    def test_names_who_was_excluded_and_why(self, session, config_1wk, monday):
        t = make_template(session, is_active=True)
        chosen = make_doctor(session, code="AA")
        on_leave = make_doctor(session, code="BB")
        no_session = make_doctor(session, code="CC")
        _req_room(session, t, chosen)
        _req_room(session, t, on_leave)
        make_leave(session, on_leave, monday, Period.AM)
        make_clinic_type(
            session, name="Dragon", room_required=False,
            schedules=[(Day.MONDAY, Period.AM)],
            doctor_eligibilities=[(chosen.id, 1), (on_leave.id, 1), (no_session.id, 1)],
        )

        ctx, grid, counters = _build(session, config_1wk)
        log = DecisionLog()
        run_phase5(ctx, grid, counters, log)

        entry = next(e for e in log.entries if e.action == "assign_clinic")
        assert "Eligible (1): AA" in entry.rationale
        assert "Not eligible (2):" in entry.rationale
        assert "BB: on leave" in entry.rationale
        assert "CC: does not work this session in the template" in entry.rationale

    def test_a_doctor_taken_by_an_earlier_clinic_is_named_with_that_clinic(
        self, session, config_1wk
    ):
        t = make_template(session, is_active=True)
        d = make_doctor(session, code="AA")
        _req_room(session, t, d)
        make_clinic_type(
            session, name="Dragon", room_required=False, clinic_priority=1,
            schedules=[(Day.MONDAY, Period.AM)],
            doctor_eligibilities=[(d.id, 1)],
        )
        make_clinic_type(
            session, name="Phoenix", room_required=False, clinic_priority=2,
            schedules=[(Day.MONDAY, Period.AM)],
            doctor_eligibilities=[(d.id, 1)],
        )

        ctx, grid, counters = _build(session, config_1wk)
        log = DecisionLog()
        run_phase5(ctx, grid, counters, log)

        # The second clinic finds nobody, and says so naming the clinic that
        # took the doctor first -- "already has a role" alone would not
        # distinguish clinic ordering from a duty assignment.
        entry = next(e for e in log.entries if e.action == "no_eligible_doctor")
        assert "AA: already assigned clinic (Dragon) this session" in entry.rationale

    def test_room_search_lists_the_rooms_and_their_occupants(self, session, config_1wk):
        t = make_template(session, is_active=True)
        clinic_doctor = make_doctor(session, code="AA")
        occupant = make_doctor(session, code="BB")
        taken_room = make_room(session, code="D1", room_type=RoomType.D)
        free_room = make_room(session, code="D2", room_type=RoomType.D)

        _req_room(session, t, clinic_doctor)
        make_master_session(
            session, t, occupant, week=1, day=Day.MONDAY, period=Period.AM,
            session_type=MasterSessionType.PRE_ASSIGNED, room=taken_room,
        )
        make_clinic_type(
            session, name="Dragon", room_required=True,
            schedules=[(Day.MONDAY, Period.AM)],
            doctor_eligibilities=[(clinic_doctor.id, 1)],
            room_ids=[taken_room.id, free_room.id],
        )

        ctx, grid, counters = _build(session, config_1wk)
        log = DecisionLog()
        run_phase5(ctx, grid, counters, log)

        entry = next(e for e in log.entries if e.action == "assign_clinic_room")
        assert "D1: held by BB" in entry.rationale
        assert "D2: free" in entry.rationale
        assert entry.rationale.endswith(
            "Decided on: first free room in that list -- D2; no displacement needed."
        )

    def test_no_eligible_doctor_is_logged_with_every_exclusion(self, session, config_1wk, monday):
        t = make_template(session, is_active=True)
        d = make_doctor(session, code="AA")
        _req_room(session, t, d)
        make_leave(session, d, monday, Period.AM)
        ct = make_clinic_type(
            session, name="Dragon", room_required=False,
            schedules=[(Day.MONDAY, Period.AM)],
            doctor_eligibilities=[(d.id, 1)],
        )

        ctx, grid, counters = _build(session, config_1wk)
        log = DecisionLog()
        run_phase5(ctx, grid, counters, log)

        entry = next(e for e in log.entries if e.action == "no_eligible_doctor")
        assert entry.clinic_type_id == ct.id
        assert entry.week == 1 and entry.day == Day.MONDAY and entry.period == Period.AM
        assert "AA: on leave" in entry.rationale
