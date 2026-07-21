from app.engine.context import load_context
from app.engine.phases.phase2 import run_phase2
from app.engine.phases.phase7_9a import _displacement_priority, run_phase7_to_9a
from app.engine.datatypes import DecisionLog
from app.models.enums import Day, DoctorType, MasterSessionType, Period, RoomType, SystemCounterType

from .factories import (
    make_doctor,
    make_leave,
    make_master_session,
    make_preferred_room,
    make_room,
    make_system_counter,
    make_template,
)


def _build(session, config):
    ctx = load_context(session, config)
    grid, counters = run_phase2(ctx, config, session)
    return ctx, grid, counters


def _requires_room(session, template, doctor, week=1, day=Day.MONDAY, period=Period.AM):
    make_master_session(
        session, template, doctor, week=week, day=day, period=period,
        session_type=MasterSessionType.REQUIRES_ROOM,
    )


def _pre_assigned(session, template, doctor, room, week=1, day=Day.MONDAY, period=Period.AM):
    make_master_session(
        session, template, doctor, week=week, day=day, period=period,
        session_type=MasterSessionType.PRE_ASSIGNED, room=room,
    )


class TestPass1FreeRoom:
    def test_free_d_room_assigned_both_sessions_no_counter(self, session, config_1wk):
        t = make_template(session, is_active=True)
        trainee = make_doctor(session, code="TT", doctor_type=DoctorType.TRAINEE)
        d_room = make_room(session, code="D1", room_type=RoomType.D)
        _requires_room(session, t, trainee, period=Period.AM)
        _requires_room(session, t, trainee, period=Period.PM)

        ctx, grid, counters = _build(session, config_1wk)
        log = DecisionLog()
        issues = run_phase7_to_9a(ctx, grid, counters, log)

        assert grid.get(trainee.id, 1, Day.MONDAY, Period.AM).assigned_room_id == d_room.id
        assert grid.get(trainee.id, 1, Day.MONDAY, Period.PM).assigned_room_id == d_room.id
        assert counters.system == {}
        assert not any(i.phase == "phase7_9a" for i in issues)

        # One assign_room entry for the full day, not two.
        entries = [e for e in log.entries if e.action == "assign_room"]
        assert len(entries) == 1
        assert entries[0].doctor_id == trainee.id
        assert entries[0].period is None  # full-day
        assert entries[0].room_id == d_room.id
        assert "pass 1" in entries[0].message


class TestPass1Displacement:
    def test_displaces_full_day_occupant_once(self, session, config_1wk):
        t = make_template(session, is_active=True)
        trainee = make_doctor(session, code="TT", doctor_type=DoctorType.TRAINEE)
        partner = make_doctor(session, code="PP", doctor_type=DoctorType.PARTNER)
        d_room = make_room(session, code="D1", room_type=RoomType.D)
        fallback = make_room(session, code="C1", room_type=RoomType.C)

        _requires_room(session, t, trainee, period=Period.AM)
        _requires_room(session, t, trainee, period=Period.PM)
        _pre_assigned(session, t, partner, d_room, period=Period.AM)
        _pre_assigned(session, t, partner, d_room, period=Period.PM)
        make_preferred_room(session, partner, preference_order=1, room=fallback)

        ctx, grid, counters = _build(session, config_1wk)
        log = DecisionLog()
        issues = run_phase7_to_9a(ctx, grid, counters, log)

        assert grid.get(trainee.id, 1, Day.MONDAY, Period.AM).assigned_room_id == d_room.id
        assert grid.get(trainee.id, 1, Day.MONDAY, Period.PM).assigned_room_id == d_room.id
        assert grid.get(partner.id, 1, Day.MONDAY, Period.AM).assigned_room_id == fallback.id
        assert grid.get(partner.id, 1, Day.MONDAY, Period.PM).assigned_room_id == fallback.id
        assert counters.system[(partner.id, SystemCounterType.ROOM_MOVE)] == 1  # once, not twice
        assert not any(i.phase == "phase7_9a" and i.severity == "warning" for i in issues)

        entries = [e for e in log.entries if e.action == "displace_room"]
        assert len(entries) == 1
        entry = entries[0]
        assert entry.doctor_id == trainee.id
        assert entry.related_doctor_id == partner.id
        assert entry.room_id == d_room.id
        assert entry.related_room_id == fallback.id
        assert entry.period is None
        assert "pass 1" in entry.message

    def test_tiebreak_lowest_room_move_score_wins(self, session, config_1wk):
        t = make_template(session, is_active=True)
        trainee = make_doctor(session, code="TT", doctor_type=DoctorType.TRAINEE)
        low_score = make_doctor(session, code="ZZ", doctor_type=DoctorType.PARTNER)
        high_score = make_doctor(session, code="AA", doctor_type=DoctorType.PARTNER)
        room_low = make_room(session, code="D1", room_type=RoomType.D)
        room_high = make_room(session, code="D2", room_type=RoomType.D)
        fallback1 = make_room(session, code="C1", room_type=RoomType.C)
        fallback2 = make_room(session, code="C2", room_type=RoomType.C)

        _requires_room(session, t, trainee, period=Period.AM)
        _requires_room(session, t, trainee, period=Period.PM)
        _pre_assigned(session, t, low_score, room_low, period=Period.AM)
        _pre_assigned(session, t, low_score, room_low, period=Period.PM)
        _pre_assigned(session, t, high_score, room_high, period=Period.AM)
        _pre_assigned(session, t, high_score, room_high, period=Period.PM)
        make_preferred_room(session, low_score, preference_order=1, room=fallback1)
        make_preferred_room(session, high_score, preference_order=1, room=fallback2)
        make_system_counter(session, low_score, SystemCounterType.ROOM_MOVE, raw_count=0)
        make_system_counter(session, high_score, SystemCounterType.ROOM_MOVE, raw_count=5)

        ctx, grid, counters = _build(session, config_1wk)
        log = DecisionLog()
        run_phase7_to_9a(ctx, grid, counters, log)

        # low_score has the lower weighted ROOM_MOVE score -> displaced, not high_score
        assert grid.get(low_score.id, 1, Day.MONDAY, Period.AM).assigned_room_id == fallback1.id
        assert grid.get(high_score.id, 1, Day.MONDAY, Period.AM).assigned_room_id == room_high.id
        assert grid.get(trainee.id, 1, Day.MONDAY, Period.AM).assigned_room_id == room_low.id

        entry = next(e for e in log.entries if e.action == "displace_room")
        assert entry.related_doctor_id == low_score.id

    def test_single_free_d_room_resolves_without_displacement(self, session, config_1wk):
        # Sanity check: one D room, nobody occupying it -- Pass 1's free-room
        # path handles this directly, no displacement needed. The genuine
        # "no candidate at all" failure case is covered separately below,
        # where zero D rooms exist.
        t = make_template(session, is_active=True)
        trainee = make_doctor(session, code="TT", doctor_type=DoctorType.TRAINEE)
        d_room = make_room(session, code="D1", room_type=RoomType.D)
        _requires_room(session, t, trainee, period=Period.AM)
        _requires_room(session, t, trainee, period=Period.PM)

        ctx, grid, counters = _build(session, config_1wk)
        log = DecisionLog()
        issues = run_phase7_to_9a(ctx, grid, counters, log)

        assert grid.get(trainee.id, 1, Day.MONDAY, Period.AM).assigned_room_id == d_room.id
        assert not any(i.phase == "phase7_9a" for i in issues)

    def test_no_d_rooms_configured_warns(self, session, config_1wk):
        t = make_template(session, is_active=True)
        trainee = make_doctor(session, code="TT", doctor_type=DoctorType.TRAINEE)
        _requires_room(session, t, trainee, period=Period.AM)
        _requires_room(session, t, trainee, period=Period.PM)

        ctx, grid, counters = _build(session, config_1wk)
        log = DecisionLog()
        issues = run_phase7_to_9a(ctx, grid, counters, log)

        assert grid.get(trainee.id, 1, Day.MONDAY, Period.AM).assigned_room_id is None
        assert any(i.check == "no_full_day_room" for i in issues)
        assert log.entries == []  # nothing was decided


class TestPass1PriorityTiers:
    """Priority 1 (different D room AM/PM) vs Priority 2 (same D room all
    day) victim selection, and the same-day consolidation check that runs
    only after a Priority 1 displacement.
    """

    def test_priority1_split_when_neither_room_consolidates(self, session, config_1wk):
        t = make_template(session, is_active=True)
        trainee = make_doctor(session, code="TT", doctor_type=DoctorType.TRAINEE)
        victim = make_doctor(session, code="V1", doctor_type=DoctorType.PARTNER)
        # Occupy the "other" session of each of the victim's D rooms so
        # neither room can consolidate once the victim moves out.
        blocker_am = make_doctor(session, code="BA", doctor_type=DoctorType.SALARIED)
        blocker_pm = make_doctor(session, code="BP", doctor_type=DoctorType.SALARIED)
        d1 = make_room(session, code="D1", room_type=RoomType.D)
        d2 = make_room(session, code="D2", room_type=RoomType.D)
        pool = make_room(session, code="C1", room_type=RoomType.C)

        _requires_room(session, t, trainee, period=Period.AM)
        _requires_room(session, t, trainee, period=Period.PM)
        _pre_assigned(session, t, victim, d1, period=Period.AM)
        _pre_assigned(session, t, victim, d2, period=Period.PM)
        _pre_assigned(session, t, blocker_pm, d1, period=Period.PM)
        _pre_assigned(session, t, blocker_am, d2, period=Period.AM)

        ctx, grid, counters = _build(session, config_1wk)
        log = DecisionLog()
        issues = run_phase7_to_9a(ctx, grid, counters, log)

        assert grid.get(trainee.id, 1, Day.MONDAY, Period.AM).assigned_room_id == d1.id
        assert grid.get(trainee.id, 1, Day.MONDAY, Period.PM).assigned_room_id == d2.id
        assert grid.get(victim.id, 1, Day.MONDAY, Period.AM).assigned_room_id == pool.id
        assert grid.get(victim.id, 1, Day.MONDAY, Period.PM).assigned_room_id == pool.id
        assert counters.system[(victim.id, SystemCounterType.ROOM_MOVE)] == 1  # once, not twice
        assert not any(i.phase == "phase7_9a" and i.severity == "warning" for i in issues)

        entries = [e for e in log.entries if e.action == "displace_room"]
        assert len(entries) == 2
        am_entry = next(e for e in entries if e.period == Period.AM)
        pm_entry = next(e for e in entries if e.period == Period.PM)
        assert am_entry.doctor_id == trainee.id and pm_entry.doctor_id == trainee.id
        assert am_entry.related_doctor_id == victim.id and pm_entry.related_doctor_id == victim.id
        assert am_entry.room_id == d1.id
        assert pm_entry.room_id == d2.id
        assert am_entry.related_room_id == pool.id and pm_entry.related_room_id == pool.id
        # The pair of entries must be legible as one move, not two.
        assert "once" in am_entry.message or "once" in pm_entry.message

    def test_priority1_consolidates_into_am_room(self, session, config_1wk):
        t = make_template(session, is_active=True)
        trainee = make_doctor(session, code="TT", doctor_type=DoctorType.TRAINEE)
        victim = make_doctor(session, code="V1", doctor_type=DoctorType.PARTNER)
        blocker = make_doctor(session, code="BL", doctor_type=DoctorType.SALARIED)
        d1 = make_room(session, code="D1", room_type=RoomType.D)
        d2 = make_room(session, code="D2", room_type=RoomType.D)
        pool = make_room(session, code="C1", room_type=RoomType.C)

        _requires_room(session, t, trainee, period=Period.AM)
        _requires_room(session, t, trainee, period=Period.PM)
        _pre_assigned(session, t, victim, d1, period=Period.AM)
        _pre_assigned(session, t, victim, d2, period=Period.PM)
        # D1-PM is left free -> once the victim leaves, D1 is free all day.
        # D2-AM is occupied -> D2 cannot consolidate.
        _pre_assigned(session, t, blocker, d2, period=Period.AM)

        ctx, grid, counters = _build(session, config_1wk)
        log = DecisionLog()
        issues = run_phase7_to_9a(ctx, grid, counters, log)

        assert grid.get(trainee.id, 1, Day.MONDAY, Period.AM).assigned_room_id == d1.id
        assert grid.get(trainee.id, 1, Day.MONDAY, Period.PM).assigned_room_id == d1.id
        assert grid.get(victim.id, 1, Day.MONDAY, Period.AM).assigned_room_id == pool.id
        assert grid.get(victim.id, 1, Day.MONDAY, Period.PM).assigned_room_id == pool.id
        assert counters.system[(victim.id, SystemCounterType.ROOM_MOVE)] == 1

        entries = [e for e in log.entries if e.action == "displace_room"]
        assert len(entries) == 1
        entry = entries[0]
        assert entry.period is None
        assert entry.doctor_id == trainee.id
        assert entry.related_doctor_id == victim.id
        assert entry.room_id == d1.id
        assert d1.code in entry.message and d2.code in entry.message

    def test_priority1_consolidates_into_pm_room(self, session, config_1wk):
        t = make_template(session, is_active=True)
        trainee = make_doctor(session, code="TT", doctor_type=DoctorType.TRAINEE)
        victim = make_doctor(session, code="V1", doctor_type=DoctorType.PARTNER)
        blocker = make_doctor(session, code="BL", doctor_type=DoctorType.SALARIED)
        d1 = make_room(session, code="D1", room_type=RoomType.D)
        d2 = make_room(session, code="D2", room_type=RoomType.D)
        pool = make_room(session, code="C1", room_type=RoomType.C)

        _requires_room(session, t, trainee, period=Period.AM)
        _requires_room(session, t, trainee, period=Period.PM)
        _pre_assigned(session, t, victim, d1, period=Period.AM)
        _pre_assigned(session, t, victim, d2, period=Period.PM)
        # D1-PM is occupied -> D1 cannot consolidate.
        # D2-AM is left free -> once the victim leaves, D2 is free all day.
        _pre_assigned(session, t, blocker, d1, period=Period.PM)

        ctx, grid, counters = _build(session, config_1wk)
        log = DecisionLog()
        issues = run_phase7_to_9a(ctx, grid, counters, log)

        assert grid.get(trainee.id, 1, Day.MONDAY, Period.AM).assigned_room_id == d2.id
        assert grid.get(trainee.id, 1, Day.MONDAY, Period.PM).assigned_room_id == d2.id
        assert grid.get(victim.id, 1, Day.MONDAY, Period.AM).assigned_room_id == pool.id
        assert grid.get(victim.id, 1, Day.MONDAY, Period.PM).assigned_room_id == pool.id
        assert counters.system[(victim.id, SystemCounterType.ROOM_MOVE)] == 1

        entries = [e for e in log.entries if e.action == "displace_room"]
        assert len(entries) == 1
        entry = entries[0]
        assert entry.period is None
        assert entry.room_id == d2.id
        assert d1.code in entry.message and d2.code in entry.message

    def test_priority1_beats_priority2_despite_worse_weighted_score(self, session, config_1wk):
        t = make_template(session, is_active=True)
        trainee = make_doctor(session, code="TT", doctor_type=DoctorType.TRAINEE)
        # Priority 1: different D rooms AM/PM, but a high (bad) ROOM_MOVE score.
        p1_victim = make_doctor(session, code="P1", doctor_type=DoctorType.PARTNER)
        # Priority 2: same D room all day, with a perfect (zero) score.
        p2_victim = make_doctor(session, code="P2", doctor_type=DoctorType.PARTNER)
        d1 = make_room(session, code="D1", room_type=RoomType.D)
        d2 = make_room(session, code="D2", room_type=RoomType.D)
        d3 = make_room(session, code="D3", room_type=RoomType.D)
        pool = make_room(session, code="C1", room_type=RoomType.C)

        _requires_room(session, t, trainee, period=Period.AM)
        _requires_room(session, t, trainee, period=Period.PM)
        _pre_assigned(session, t, p1_victim, d1, period=Period.AM)
        _pre_assigned(session, t, p1_victim, d2, period=Period.PM)
        _pre_assigned(session, t, p2_victim, d3, period=Period.AM)
        _pre_assigned(session, t, p2_victim, d3, period=Period.PM)
        make_system_counter(session, p1_victim, SystemCounterType.ROOM_MOVE, raw_count=5)
        make_system_counter(session, p2_victim, SystemCounterType.ROOM_MOVE, raw_count=0)

        ctx, grid, counters = _build(session, config_1wk)
        log = DecisionLog()
        run_phase7_to_9a(ctx, grid, counters, log)

        # p2_victim has the far better weighted score but is only a
        # Priority 2 candidate -- tier is checked before score, so
        # p1_victim (Priority 1) is displaced instead.
        assert grid.get(p1_victim.id, 1, Day.MONDAY, Period.AM).assigned_room_id == pool.id
        assert grid.get(p1_victim.id, 1, Day.MONDAY, Period.PM).assigned_room_id == pool.id
        assert grid.get(p2_victim.id, 1, Day.MONDAY, Period.AM).assigned_room_id == d3.id
        assert grid.get(p2_victim.id, 1, Day.MONDAY, Period.PM).assigned_room_id == d3.id
        assert counters.system.get((p2_victim.id, SystemCounterType.ROOM_MOVE), 0) == 0

        entries = [e for e in log.entries if e.action == "displace_room"]
        assert len(entries) >= 1
        assert all(e.related_doctor_id == p1_victim.id for e in entries)

    def test_priority1_no_receiving_room_leaves_victim_and_trainee_untouched(self, session, config_1wk):
        t = make_template(session, is_active=True)
        trainee = make_doctor(session, code="TT", doctor_type=DoctorType.TRAINEE)
        victim = make_doctor(session, code="V1", doctor_type=DoctorType.PARTNER)
        blocker_am = make_doctor(session, code="BA", doctor_type=DoctorType.SALARIED)
        blocker_pm = make_doctor(session, code="BP", doctor_type=DoctorType.SALARIED)
        # The only pool room is occupied all day, so nowhere exists to send
        # a displaced victim -- neither Pass 1 nor Pass 2 can rescue this.
        pool_blocker = make_doctor(session, code="CB", doctor_type=DoctorType.SALARIED)
        d1 = make_room(session, code="D1", room_type=RoomType.D)
        d2 = make_room(session, code="D2", room_type=RoomType.D)
        pool = make_room(session, code="C1", room_type=RoomType.C)

        _requires_room(session, t, trainee, period=Period.AM)
        _requires_room(session, t, trainee, period=Period.PM)
        _pre_assigned(session, t, victim, d1, period=Period.AM)
        _pre_assigned(session, t, victim, d2, period=Period.PM)
        _pre_assigned(session, t, blocker_pm, d1, period=Period.PM)
        _pre_assigned(session, t, blocker_am, d2, period=Period.AM)
        _pre_assigned(session, t, pool_blocker, pool, period=Period.AM)
        _pre_assigned(session, t, pool_blocker, pool, period=Period.PM)

        ctx, grid, counters = _build(session, config_1wk)
        log = DecisionLog()
        issues = run_phase7_to_9a(ctx, grid, counters, log)

        phase_issues = [i for i in issues if i.phase == "phase7_9a"]
        assert any(i.check == "no_full_day_room" for i in phase_issues)

        assert grid.get(trainee.id, 1, Day.MONDAY, Period.AM).assigned_room_id is None
        assert grid.get(trainee.id, 1, Day.MONDAY, Period.PM).assigned_room_id is None
        assert grid.get(victim.id, 1, Day.MONDAY, Period.AM).assigned_room_id == d1.id
        assert grid.get(victim.id, 1, Day.MONDAY, Period.PM).assigned_room_id == d2.id
        assert counters.system.get((victim.id, SystemCounterType.ROOM_MOVE), 0) == 0
        assert not any(e.action == "displace_room" for e in log.entries)


class TestPass1ReceivingRoomPool:
    """Pass 1 relocates a displaced doctor from the fixed C/W/SR pool, by
    room id, never from the displaced doctor's own preference list.
    """

    def test_pool_search_skips_occupied_room_takes_next_by_id(self, session, config_1wk):
        # C1 (lower id) is occupied, so the pool search moves on to W1.
        # This is the pool-search fallback, not a preference-list fallback
        # -- Pass 1 never reads the victim's preference list at all.
        t = make_template(session, is_active=True)
        trainee = make_doctor(session, code="TT", doctor_type=DoctorType.TRAINEE)
        partner = make_doctor(session, code="PP", doctor_type=DoctorType.PARTNER)
        d_room = make_room(session, code="D1", room_type=RoomType.D)
        pool_first = make_room(session, code="C1", room_type=RoomType.C)
        pool_second = make_room(session, code="W1", room_type=RoomType.W)

        _requires_room(session, t, trainee, period=Period.AM)
        _requires_room(session, t, trainee, period=Period.PM)
        _pre_assigned(session, t, partner, d_room, period=Period.AM)
        _pre_assigned(session, t, partner, d_room, period=Period.PM)

        ctx, grid, counters = _build(session, config_1wk)
        # Occupy pool_first (both sessions) so it is unavailable.
        blocker = make_doctor(session, code="QQ", doctor_type=DoctorType.SALARIED)
        from app.engine.datatypes import SessionSlot
        for period in (Period.AM, Period.PM):
            s = SessionSlot(
                doctor_id=blocker.id, week=1, day=Day.MONDAY, period=period,
                template_type=MasterSessionType.PRE_ASSIGNED,
            )
            grid.add_slot(s)
            grid.assign_room(1, Day.MONDAY, period, blocker.id, pool_first.id)

        log = DecisionLog()
        issues = run_phase7_to_9a(ctx, grid, counters, log)

        assert grid.get(partner.id, 1, Day.MONDAY, Period.AM).assigned_room_id == pool_second.id
        assert grid.get(trainee.id, 1, Day.MONDAY, Period.AM).assigned_room_id == d_room.id

    def test_preference_list_ignored_first_free_pool_room_used(self, session, config_1wk):
        # C1 (lower id, first in the pool) is free, and is NOT the victim's
        # preferred room -- Pass 1 must still use it, proving the
        # preference-list step is gone from Pass 1's receiving-room search.
        t = make_template(session, is_active=True)
        trainee = make_doctor(session, code="TT", doctor_type=DoctorType.TRAINEE)
        victim = make_doctor(session, code="V1", doctor_type=DoctorType.PARTNER)
        d_room = make_room(session, code="D1", room_type=RoomType.D)
        pool_first = make_room(session, code="C1", room_type=RoomType.C)
        pool_second = make_room(session, code="W1", room_type=RoomType.W)

        _requires_room(session, t, trainee, period=Period.AM)
        _requires_room(session, t, trainee, period=Period.PM)
        _pre_assigned(session, t, victim, d_room, period=Period.AM)
        _pre_assigned(session, t, victim, d_room, period=Period.PM)
        make_preferred_room(session, victim, preference_order=1, room=pool_second)

        ctx, grid, counters = _build(session, config_1wk)
        log = DecisionLog()
        issues = run_phase7_to_9a(ctx, grid, counters, log)

        assert grid.get(victim.id, 1, Day.MONDAY, Period.AM).assigned_room_id == pool_first.id
        assert grid.get(victim.id, 1, Day.MONDAY, Period.PM).assigned_room_id == pool_first.id
        assert grid.get(trainee.id, 1, Day.MONDAY, Period.AM).assigned_room_id == d_room.id
        assert grid.get(trainee.id, 1, Day.MONDAY, Period.PM).assigned_room_id == d_room.id


class TestPass2SingleSession:
    def test_partial_full_day_failure_still_resolves_per_session(self, session, config_1wk):
        """Pass 1 requires the same D room free/displaceable in BOTH sessions.

        Here only one D room exists, and it's occupied only in AM (by a
        displaceable Partner) -- PM is free the whole time. Pass 1's
        full-day path genuinely fails (the AM occupant has no PM D room, so
        they are not even a full-day candidate) and correctly warns -- that
        warning is not retracted even though Pass 2 goes on to resolve AM
        (by displacement) and PM (by the plain free-room path)
        independently. With only one D room in this fixture both sessions
        land in the same room, but in general Pass 2 resolving sessions
        independently could split a doctor across two different D rooms in
        one day, which is exactly what the Pass 1 warning is meant to flag
        for review -- so the warning is expected, not a defect.
        """
        t = make_template(session, is_active=True)
        trainee = make_doctor(session, code="TT", doctor_type=DoctorType.TRAINEE)
        am_occupant = make_doctor(session, code="AM", doctor_type=DoctorType.PARTNER)
        d_room = make_room(session, code="D1", room_type=RoomType.D)
        fallback = make_room(session, code="C1", room_type=RoomType.C)

        _requires_room(session, t, trainee, period=Period.AM)
        _requires_room(session, t, trainee, period=Period.PM)
        _pre_assigned(session, t, am_occupant, d_room, period=Period.AM)
        make_preferred_room(session, am_occupant, preference_order=1, room=fallback)

        ctx, grid, counters = _build(session, config_1wk)
        log = DecisionLog()
        issues = run_phase7_to_9a(ctx, grid, counters, log)

        assert grid.get(trainee.id, 1, Day.MONDAY, Period.AM).assigned_room_id == d_room.id
        assert grid.get(trainee.id, 1, Day.MONDAY, Period.PM).assigned_room_id == d_room.id
        assert grid.get(am_occupant.id, 1, Day.MONDAY, Period.AM).assigned_room_id == fallback.id
        assert counters.system[(am_occupant.id, SystemCounterType.ROOM_MOVE)] == 1

        # Pass 1's full-day attempt genuinely failed before Pass 2 patched
        # it up per-session -- exactly one warning, from Pass 1, expected.
        phase_issues = [i for i in issues if i.phase == "phase7_9a"]
        assert len(phase_issues) == 1
        assert phase_issues[0].check == "no_full_day_room"
        assert phase_issues[0].severity == "warning"

        # PM resolved via the free-room path (pass 2); AM resolved via
        # displacement (pass 2, since pass 1 failed on this doctor).
        assign_entries = [e for e in log.entries if e.action == "assign_room"]
        displace_entries = [e for e in log.entries if e.action == "displace_room"]
        assert len(assign_entries) == 1
        assert assign_entries[0].period == Period.PM
        assert "pass 2" in assign_entries[0].message
        assert len(displace_entries) == 1
        assert displace_entries[0].period == Period.AM
        assert "pass 2" in displace_entries[0].message


class TestPass3PartnerSalariedFallback:
    def test_first_free_preferred_room_assigned_no_displacement(self, session, config_1wk):
        t = make_template(session, is_active=True)
        partner = make_doctor(session, code="PP", doctor_type=DoctorType.PARTNER)
        preferred = make_room(session, code="C1", room_type=RoomType.C)
        occupant = make_doctor(session, code="OO", doctor_type=DoctorType.SALARIED)
        occupied_room = make_room(session, code="C2", room_type=RoomType.C)

        _requires_room(session, t, partner)
        make_preferred_room(session, partner, preference_order=1, room=occupied_room)
        make_preferred_room(session, partner, preference_order=2, room=preferred)
        _pre_assigned(session, t, occupant, occupied_room)

        ctx, grid, counters = _build(session, config_1wk)
        log = DecisionLog()
        issues = run_phase7_to_9a(ctx, grid, counters, log)

        # occupied_room stays with occupant -- Pass 3 never displaces
        assert grid.get(occupant.id, 1, Day.MONDAY, Period.AM).assigned_room_id == occupied_room.id
        assert grid.get(partner.id, 1, Day.MONDAY, Period.AM).assigned_room_id == preferred.id

        entries = [e for e in log.entries if e.action == "assign_room"]
        assert len(entries) == 1
        assert entries[0].doctor_id == partner.id
        assert entries[0].room_id == preferred.id
        assert "pass 3" in entries[0].message

    def test_falls_back_to_free_non_preferred_room_when_preference_list_exhausted(
        self, session, config_1wk
    ):
        t = make_template(session, is_active=True)
        partner = make_doctor(session, code="PP", doctor_type=DoctorType.PARTNER)
        preferred_but_occupied = make_room(session, code="C1", room_type=RoomType.C)
        occupant = make_doctor(session, code="OO", doctor_type=DoctorType.SALARIED)
        # A totally free room exists but is NOT in the partner's preference
        # list -- Pass 3 now forces the doctor into it rather than leaving
        # the slot unresolved.
        free_room = make_room(session, code="C2", room_type=RoomType.C)

        _requires_room(session, t, partner)
        make_preferred_room(session, partner, preference_order=1, room=preferred_but_occupied)
        _pre_assigned(session, t, occupant, preferred_but_occupied)

        ctx, grid, counters = _build(session, config_1wk)
        log = DecisionLog()
        issues = run_phase7_to_9a(ctx, grid, counters, log)

        assert grid.get(partner.id, 1, Day.MONDAY, Period.AM).assigned_room_id == free_room.id
        assert not any(i.check == "no_partner_salaried_room" for i in issues)

        entries = [e for e in log.entries if e.action == "assign_room"]
        assert len(entries) == 1
        assert entries[0].doctor_id == partner.id
        assert entries[0].room_id == free_room.id
        assert "pass 3" in entries[0].message
        assert "fallback" in entries[0].message

    def test_fallback_order_d_before_c_before_w_before_sr(self, session, config_1wk):
        t = make_template(session, is_active=True)
        partner = make_doctor(session, code="PP", doctor_type=DoctorType.PARTNER)
        w_room = make_room(session, code="W1", room_type=RoomType.W)
        c_room = make_room(session, code="C1", room_type=RoomType.C)
        d_room = make_room(session, code="D1", room_type=RoomType.D)
        sr_room = make_room(session, code="SR1", room_type=RoomType.SR)
        # No preferred rooms configured at all -- straight to fallback.
        _requires_room(session, t, partner)

        ctx, grid, counters = _build(session, config_1wk)
        log = DecisionLog()
        issues = run_phase7_to_9a(ctx, grid, counters, log)

        assert grid.get(partner.id, 1, Day.MONDAY, Period.AM).assigned_room_id == d_room.id
        assert not any(i.check == "no_partner_salaried_room" for i in issues)

    def test_fallback_order_c_before_w_and_sr_when_d_occupied(self, session, config_1wk):
        t = make_template(session, is_active=True)
        partner = make_doctor(session, code="PP", doctor_type=DoctorType.PARTNER)
        d_occupant = make_doctor(session, code="OO", doctor_type=DoctorType.SALARIED)
        d_room = make_room(session, code="D1", room_type=RoomType.D)
        w_room = make_room(session, code="W1", room_type=RoomType.W)
        c_room = make_room(session, code="C1", room_type=RoomType.C)
        sr_room = make_room(session, code="SR1", room_type=RoomType.SR)

        _requires_room(session, t, partner)
        _pre_assigned(session, t, d_occupant, d_room)

        ctx, grid, counters = _build(session, config_1wk)
        log = DecisionLog()
        issues = run_phase7_to_9a(ctx, grid, counters, log)

        assert grid.get(partner.id, 1, Day.MONDAY, Period.AM).assigned_room_id == c_room.id
        assert not any(i.check == "no_partner_salaried_room" for i in issues)

    def test_fallback_within_type_orders_by_code_not_creation_order(self, session, config_1wk):
        t = make_template(session, is_active=True)
        partner = make_doctor(session, code="PP", doctor_type=DoctorType.PARTNER)
        # Created out of code order -- C2 first, then C1 -- to prove the
        # fallback sorts by code, not creation/id order.
        later_code_room = make_room(session, code="C2", room_type=RoomType.C)
        earlier_code_room = make_room(session, code="C1", room_type=RoomType.C)

        _requires_room(session, t, partner)

        ctx, grid, counters = _build(session, config_1wk)
        log = DecisionLog()
        issues = run_phase7_to_9a(ctx, grid, counters, log)

        assert grid.get(partner.id, 1, Day.MONDAY, Period.AM).assigned_room_id == earlier_code_room.id
        assert not any(i.check == "no_partner_salaried_room" for i in issues)

    def test_warns_only_when_every_room_occupied(self, session, config_1wk):
        t = make_template(session, is_active=True)
        partner = make_doctor(session, code="PP", doctor_type=DoctorType.PARTNER)
        occupant = make_doctor(session, code="OO", doctor_type=DoctorType.SALARIED)
        only_room = make_room(session, code="C1", room_type=RoomType.C)

        _requires_room(session, t, partner)
        _pre_assigned(session, t, occupant, only_room)

        ctx, grid, counters = _build(session, config_1wk)
        log = DecisionLog()
        issues = run_phase7_to_9a(ctx, grid, counters, log)

        assert grid.get(partner.id, 1, Day.MONDAY, Period.AM).assigned_room_id is None
        warning = next(i for i in issues if i.check == "no_partner_salaried_room")
        assert "No free room anywhere" in warning.message
        assert log.entries == []


class TestPass2DisplacementPriorityFunction:
    """`_displacement_priority` classification, tested directly against the
    three tier-1 cases: other session absent, on leave, or REQUIRES_ROOM but
    not yet assigned a room (the pre-Pass-3 partner case).
    """

    def test_tier1_when_other_session_absent(self, session, config_1wk):
        t = make_template(session, is_active=True)
        partner = make_doctor(session, code="PP", doctor_type=DoctorType.PARTNER)
        d_room = make_room(session, code="D1", room_type=RoomType.D)
        _pre_assigned(session, t, partner, d_room, period=Period.AM)
        # No PM master session row at all for this doctor.

        ctx, grid, counters = _build(session, config_1wk)
        tier = _displacement_priority(grid, partner.id, 1, Day.MONDAY, Period.AM, d_room.id)
        assert tier == 1

    def test_tier1_when_other_session_on_leave(self, session, config_1wk, monday):
        t = make_template(session, is_active=True)
        partner = make_doctor(session, code="PP", doctor_type=DoctorType.PARTNER)
        d_room = make_room(session, code="D1", room_type=RoomType.D)
        _pre_assigned(session, t, partner, d_room, period=Period.AM)
        _pre_assigned(session, t, partner, d_room, period=Period.PM)
        make_leave(session, partner, monday, period=Period.PM)

        ctx, grid, counters = _build(session, config_1wk)
        tier = _displacement_priority(grid, partner.id, 1, Day.MONDAY, Period.AM, d_room.id)
        assert tier == 1

    def test_tier1_when_other_session_requires_room_unassigned(self, session, config_1wk):
        t = make_template(session, is_active=True)
        partner = make_doctor(session, code="PP", doctor_type=DoctorType.PARTNER)
        d_room = make_room(session, code="D1", room_type=RoomType.D)
        _pre_assigned(session, t, partner, d_room, period=Period.AM)
        _requires_room(session, t, partner, period=Period.PM)  # unassigned

        ctx, grid, counters = _build(session, config_1wk)
        tier = _displacement_priority(grid, partner.id, 1, Day.MONDAY, Period.AM, d_room.id)
        assert tier == 1

    def test_end_to_end_requires_room_unassigned_partner_preferred_for_displacement(
        self, session, config_1wk
    ):
        """Same tier-1 case as above, but exercised through the full Pass 2
        selection (`_pass2_single_session`) rather than the bare function,
        and pitted against a tier-3 occupant with a far better fairness
        score to confirm the classification actually drives the pick.
        """
        t = make_template(session, is_active=True)
        trainee = make_doctor(session, code="TT", doctor_type=DoctorType.TRAINEE)
        tier1_partner = make_doctor(session, code="P1", doctor_type=DoctorType.PARTNER)
        tier3_partner = make_doctor(session, code="P3", doctor_type=DoctorType.PARTNER)
        d1 = make_room(session, code="D1", room_type=RoomType.D)
        d2 = make_room(session, code="D2", room_type=RoomType.D)
        fallback = make_room(session, code="C1", room_type=RoomType.C)

        _requires_room(session, t, trainee, period=Period.AM)
        _pre_assigned(session, t, tier1_partner, d1, period=Period.AM)
        _requires_room(session, t, tier1_partner, period=Period.PM)  # unassigned -> tier 1
        _pre_assigned(session, t, tier3_partner, d2, period=Period.AM)
        _pre_assigned(session, t, tier3_partner, d2, period=Period.PM)  # tier 3
        make_preferred_room(session, tier1_partner, preference_order=1, room=fallback)
        make_system_counter(session, tier1_partner, SystemCounterType.ROOM_MOVE, raw_count=5)
        make_system_counter(session, tier3_partner, SystemCounterType.ROOM_MOVE, raw_count=0)

        ctx, grid, counters = _build(session, config_1wk)
        log = DecisionLog()
        run_phase7_to_9a(ctx, grid, counters, log)

        assert grid.get(tier1_partner.id, 1, Day.MONDAY, Period.AM).assigned_room_id == fallback.id
        assert grid.get(tier3_partner.id, 1, Day.MONDAY, Period.AM).assigned_room_id == d2.id
        assert grid.get(trainee.id, 1, Day.MONDAY, Period.AM).assigned_room_id == d1.id

        entry = next(e for e in log.entries if e.action == "displace_room")
        assert entry.related_doctor_id == tier1_partner.id
        assert "priority tier 1" in entry.message


class TestPass2TierOrderingBeatsFairness:
    """Tier ranking is checked before the weighted fairness score -- tests
    Design Decisions 4 and 5.
    """

    def test_tier1_wins_over_tier3_despite_worse_score(self, session, config_1wk):
        t = make_template(session, is_active=True)
        trainee = make_doctor(session, code="TT", doctor_type=DoctorType.TRAINEE)
        tier3_doc = make_doctor(session, code="T3", doctor_type=DoctorType.PARTNER)
        tier1_doc = make_doctor(session, code="T1", doctor_type=DoctorType.PARTNER)
        d1 = make_room(session, code="D1", room_type=RoomType.D)
        d2 = make_room(session, code="D2", room_type=RoomType.D)
        fallback1 = make_room(session, code="C1", room_type=RoomType.C)
        fallback2 = make_room(session, code="C2", room_type=RoomType.C)

        _requires_room(session, t, trainee, period=Period.AM)
        # tier3_doc: same D room (d1) all day -- tier 3, favourable score.
        _pre_assigned(session, t, tier3_doc, d1, period=Period.AM)
        _pre_assigned(session, t, tier3_doc, d1, period=Period.PM)
        # tier1_doc: only an AM slot at all -- other session absent -> tier 1,
        # unfavourable score.
        _pre_assigned(session, t, tier1_doc, d2, period=Period.AM)
        make_preferred_room(session, tier3_doc, preference_order=1, room=fallback1)
        make_preferred_room(session, tier1_doc, preference_order=1, room=fallback2)
        make_system_counter(session, tier3_doc, SystemCounterType.ROOM_MOVE, raw_count=0)
        make_system_counter(session, tier1_doc, SystemCounterType.ROOM_MOVE, raw_count=5)

        ctx, grid, counters = _build(session, config_1wk)
        log = DecisionLog()
        run_phase7_to_9a(ctx, grid, counters, log)

        # tier1_doc is displaced despite the far worse weighted score --
        # tier is checked first.
        assert grid.get(tier1_doc.id, 1, Day.MONDAY, Period.AM).assigned_room_id == fallback2.id
        assert grid.get(tier3_doc.id, 1, Day.MONDAY, Period.AM).assigned_room_id == d1.id
        assert grid.get(tier3_doc.id, 1, Day.MONDAY, Period.PM).assigned_room_id == d1.id

        # The trainee receives d2 -- the room whose occupant was cheaper to
        # move (Design Decision 4: tier steers which room the trainee gets).
        assert grid.get(trainee.id, 1, Day.MONDAY, Period.AM).assigned_room_id == d2.id

        entry = next(e for e in log.entries if e.action == "displace_room")
        assert entry.related_doctor_id == tier1_doc.id
        assert "priority tier 1" in entry.message

    def test_tier2_wins_over_tier3_despite_worse_score(self, session, config_1wk):
        t = make_template(session, is_active=True)
        trainee = make_doctor(session, code="TT", doctor_type=DoctorType.TRAINEE)
        tier2_doc = make_doctor(session, code="T2", doctor_type=DoctorType.PARTNER)
        tier3_doc = make_doctor(session, code="T3", doctor_type=DoctorType.PARTNER)
        d1 = make_room(session, code="D1", room_type=RoomType.D)
        d2 = make_room(session, code="D2", room_type=RoomType.D)
        other_room = make_room(session, code="C1", room_type=RoomType.C)
        fallback1 = make_room(session, code="C2", room_type=RoomType.C)
        fallback2 = make_room(session, code="C3", room_type=RoomType.C)

        _requires_room(session, t, trainee, period=Period.AM)
        # tier2_doc: d1 in AM, a different (non-D) room in PM -- tier 2.
        _pre_assigned(session, t, tier2_doc, d1, period=Period.AM)
        _pre_assigned(session, t, tier2_doc, other_room, period=Period.PM)
        # tier3_doc: same D room (d2) all day -- tier 3.
        _pre_assigned(session, t, tier3_doc, d2, period=Period.AM)
        _pre_assigned(session, t, tier3_doc, d2, period=Period.PM)
        make_preferred_room(session, tier2_doc, preference_order=1, room=fallback1)
        make_preferred_room(session, tier3_doc, preference_order=1, room=fallback2)
        # tier2_doc has the worse (higher) score, to prove tier still wins.
        make_system_counter(session, tier2_doc, SystemCounterType.ROOM_MOVE, raw_count=5)
        make_system_counter(session, tier3_doc, SystemCounterType.ROOM_MOVE, raw_count=0)

        ctx, grid, counters = _build(session, config_1wk)
        log = DecisionLog()
        run_phase7_to_9a(ctx, grid, counters, log)

        assert grid.get(tier2_doc.id, 1, Day.MONDAY, Period.AM).assigned_room_id == fallback1.id
        assert grid.get(tier3_doc.id, 1, Day.MONDAY, Period.AM).assigned_room_id == d2.id
        assert grid.get(trainee.id, 1, Day.MONDAY, Period.AM).assigned_room_id == d1.id

        entry = next(e for e in log.entries if e.action == "displace_room")
        assert entry.related_doctor_id == tier2_doc.id
        assert "priority tier 2" in entry.message


class TestPass2FairnessTiebreakWithinTier:
    """Within a single tier, the existing weighted-score/code tiebreak still
    governs -- Design Decision 5.
    """

    def test_lower_weighted_score_displaced_within_same_tier(self, session, config_1wk):
        t = make_template(session, is_active=True)
        trainee = make_doctor(session, code="TT", doctor_type=DoctorType.TRAINEE)
        low_score = make_doctor(session, code="LS", doctor_type=DoctorType.PARTNER)
        high_score = make_doctor(session, code="HS", doctor_type=DoctorType.PARTNER)
        d1 = make_room(session, code="D1", room_type=RoomType.D)
        d2 = make_room(session, code="D2", room_type=RoomType.D)
        fallback1 = make_room(session, code="C1", room_type=RoomType.C)
        fallback2 = make_room(session, code="C2", room_type=RoomType.C)

        _requires_room(session, t, trainee, period=Period.AM)
        # Both tier 1 -- neither has a PM master session at all.
        _pre_assigned(session, t, low_score, d1, period=Period.AM)
        _pre_assigned(session, t, high_score, d2, period=Period.AM)
        make_preferred_room(session, low_score, preference_order=1, room=fallback1)
        make_preferred_room(session, high_score, preference_order=1, room=fallback2)
        make_system_counter(session, low_score, SystemCounterType.ROOM_MOVE, raw_count=0)
        make_system_counter(session, high_score, SystemCounterType.ROOM_MOVE, raw_count=5)

        ctx, grid, counters = _build(session, config_1wk)
        log = DecisionLog()
        run_phase7_to_9a(ctx, grid, counters, log)

        assert grid.get(low_score.id, 1, Day.MONDAY, Period.AM).assigned_room_id == fallback1.id
        assert grid.get(high_score.id, 1, Day.MONDAY, Period.AM).assigned_room_id == d2.id
        assert grid.get(trainee.id, 1, Day.MONDAY, Period.AM).assigned_room_id == d1.id

    def test_equal_scores_fall_back_to_alphabetical_code(self, session, config_1wk):
        t = make_template(session, is_active=True)
        trainee = make_doctor(session, code="TT", doctor_type=DoctorType.TRAINEE)
        first_code = make_doctor(session, code="AA", doctor_type=DoctorType.PARTNER)
        later_code = make_doctor(session, code="ZZ", doctor_type=DoctorType.PARTNER)
        d1 = make_room(session, code="D1", room_type=RoomType.D)
        d2 = make_room(session, code="D2", room_type=RoomType.D)
        fallback1 = make_room(session, code="C1", room_type=RoomType.C)
        fallback2 = make_room(session, code="C2", room_type=RoomType.C)

        _requires_room(session, t, trainee, period=Period.AM)
        # Both tier 1, both zero score -- code is the only remaining
        # differentiator.
        _pre_assigned(session, t, first_code, d1, period=Period.AM)
        _pre_assigned(session, t, later_code, d2, period=Period.AM)
        make_preferred_room(session, first_code, preference_order=1, room=fallback1)
        make_preferred_room(session, later_code, preference_order=1, room=fallback2)

        ctx, grid, counters = _build(session, config_1wk)
        log = DecisionLog()
        run_phase7_to_9a(ctx, grid, counters, log)

        # "AA" sorts before "ZZ" -- it is displaced, "ZZ" is left alone.
        assert grid.get(first_code.id, 1, Day.MONDAY, Period.AM).assigned_room_id == fallback1.id
        assert grid.get(later_code.id, 1, Day.MONDAY, Period.AM).assigned_room_id == d2.id
        assert grid.get(trainee.id, 1, Day.MONDAY, Period.AM).assigned_room_id == d1.id


class TestPass2DoubleBump:
    """Design Decision 3: a doctor bumped in AM reclassifies from tier 3 to
    tier 2 for PM (their AM room no longer matches the D room), so the same
    doctor can be selected again rather than fragmenting a second intact
    tier-3 doctor. This test pins that accepted behaviour.
    """

    def test_same_doctor_bumped_am_and_pm_in_preference_to_untouched_doctor(
        self, session, config_1wk
    ):
        t = make_template(session, is_active=True)
        trainee_am = make_doctor(session, code="TA", doctor_type=DoctorType.TRAINEE)
        trainee_pm = make_doctor(session, code="TB", doctor_type=DoctorType.TRAINEE)
        partner_x = make_doctor(session, code="PA", doctor_type=DoctorType.PARTNER)
        partner_y = make_doctor(session, code="PB", doctor_type=DoctorType.PARTNER)
        d1 = make_room(session, code="D1", room_type=RoomType.D)
        d2 = make_room(session, code="D2", room_type=RoomType.D)
        fallback = make_room(session, code="C1", room_type=RoomType.C)

        _requires_room(session, t, trainee_am, period=Period.AM)
        _requires_room(session, t, trainee_pm, period=Period.PM)
        # Both partners intact full-day, same D room all day -- both start
        # tier 3 with equal (zero) ROOM_MOVE scores, so the AM pick comes
        # down to the alphabetical tiebreak ("PA" < "PB").
        _pre_assigned(session, t, partner_x, d1, period=Period.AM)
        _pre_assigned(session, t, partner_x, d1, period=Period.PM)
        _pre_assigned(session, t, partner_y, d2, period=Period.AM)
        _pre_assigned(session, t, partner_y, d2, period=Period.PM)
        make_preferred_room(session, partner_x, preference_order=1, room=fallback)
        make_preferred_room(session, partner_y, preference_order=1, room=fallback)

        ctx, grid, counters = _build(session, config_1wk)
        log = DecisionLog()
        issues = run_phase7_to_9a(ctx, grid, counters, log)

        assert not any(i.phase == "phase7_9a" and i.severity == "warning" for i in issues)

        # partner_x is bumped in both AM and PM; partner_y is never touched.
        assert grid.get(partner_x.id, 1, Day.MONDAY, Period.AM).assigned_room_id == fallback.id
        assert grid.get(partner_x.id, 1, Day.MONDAY, Period.PM).assigned_room_id == fallback.id
        assert grid.get(partner_y.id, 1, Day.MONDAY, Period.AM).assigned_room_id == d2.id
        assert grid.get(partner_y.id, 1, Day.MONDAY, Period.PM).assigned_room_id == d2.id

        assert grid.get(trainee_am.id, 1, Day.MONDAY, Period.AM).assigned_room_id == d1.id
        assert grid.get(trainee_pm.id, 1, Day.MONDAY, Period.PM).assigned_room_id == d1.id

        assert counters.system[(partner_x.id, SystemCounterType.ROOM_MOVE)] == 2
        assert counters.system.get((partner_y.id, SystemCounterType.ROOM_MOVE), 0) == 0

        displace_entries = [e for e in log.entries if e.action == "displace_room"]
        assert len(displace_entries) == 2
        assert all(e.related_doctor_id == partner_x.id for e in displace_entries)
        am_entry = next(e for e in displace_entries if e.period == Period.AM)
        pm_entry = next(e for e in displace_entries if e.period == Period.PM)
        # AM: partner_x is still fully intact (same D room both sessions) at
        # the moment of selection -- tier 3. PM: after the AM bump their AM
        # room no longer matches d1 -- tier 2.
        assert "priority tier 3" in am_entry.message
        assert "priority tier 2" in pm_entry.message