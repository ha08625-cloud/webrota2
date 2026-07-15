from app.engine.context import load_context
from app.engine.phases.phase2 import run_phase2
from app.engine.phases.phase7_9a import run_phase7_to_9a
from app.engine.datatypes import DecisionLog
from app.models.enums import Day, DoctorType, MasterSessionType, Period, RoomType, SystemCounterType

from .factories import (
    make_doctor,
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

    def test_fallback_to_non_preferred_cw_sr_room_when_preferred_unavailable(self, session, config_1wk):
        t = make_template(session, is_active=True)
        trainee = make_doctor(session, code="TT", doctor_type=DoctorType.TRAINEE)
        partner = make_doctor(session, code="PP", doctor_type=DoctorType.PARTNER)
        d_room = make_room(session, code="D1", room_type=RoomType.D)
        preferred = make_room(session, code="C1", room_type=RoomType.C)
        fallback = make_room(session, code="W1", room_type=RoomType.W)

        _requires_room(session, t, trainee, period=Period.AM)
        _requires_room(session, t, trainee, period=Period.PM)
        _pre_assigned(session, t, partner, d_room, period=Period.AM)
        _pre_assigned(session, t, partner, d_room, period=Period.PM)
        make_preferred_room(session, partner, preference_order=1, room=preferred)

        ctx, grid, counters = _build(session, config_1wk)
        # occupy the partner's preferred room so it's unavailable
        blocker = make_doctor(session, code="QQ", doctor_type=DoctorType.SALARIED)
        from app.engine.datatypes import SessionSlot
        for period in (Period.AM, Period.PM):
            s = SessionSlot(
                doctor_id=blocker.id, week=1, day=Day.MONDAY, period=period,
                template_type=MasterSessionType.PRE_ASSIGNED,
            )
            grid.add_slot(s)
            grid.assign_room(1, Day.MONDAY, period, blocker.id, preferred.id)

        log = DecisionLog()
        issues = run_phase7_to_9a(ctx, grid, counters, log)

        assert grid.get(partner.id, 1, Day.MONDAY, Period.AM).assigned_room_id == fallback.id
        assert grid.get(trainee.id, 1, Day.MONDAY, Period.AM).assigned_room_id == d_room.id

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


class TestPass2SingleSession:
    def test_partial_full_day_failure_still_resolves_per_session(self, session, config_1wk):
        """Pass 1 requires the same D room free/displaceable in BOTH sessions.

        Here only one D room exists, and it's occupied only in AM (by a
        displaceable Partner) -- PM is free the whole time. Pass 1's
        full-day path genuinely fails (AM occupant != PM occupant, since PM
        has none) and correctly warns -- that warning is not retracted even
        though Pass 2 goes on to resolve AM (by displacement) and PM (by
        the plain free-room path) independently. With only one D room in
        this fixture both sessions land in the same room, but in general
        Pass 2 resolving sessions independently could split a doctor across
        two different D rooms in one day, which is exactly what the Pass 1
        warning is meant to flag for review -- so the warning is expected,
        not a defect.
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

    def test_no_fallback_beyond_own_preference_list(self, session, config_1wk):
        t = make_template(session, is_active=True)
        partner = make_doctor(session, code="PP", doctor_type=DoctorType.PARTNER)
        preferred_but_occupied = make_room(session, code="C1", room_type=RoomType.C)
        occupant = make_doctor(session, code="OO", doctor_type=DoctorType.SALARIED)
        # A totally free room exists, but it is NOT in the partner's
        # preference list -- Pass 3 must not use it.
        make_room(session, code="C2", room_type=RoomType.C)

        _requires_room(session, t, partner)
        make_preferred_room(session, partner, preference_order=1, room=preferred_but_occupied)
        _pre_assigned(session, t, occupant, preferred_but_occupied)

        ctx, grid, counters = _build(session, config_1wk)
        log = DecisionLog()
        issues = run_phase7_to_9a(ctx, grid, counters, log)

        assert grid.get(partner.id, 1, Day.MONDAY, Period.AM).assigned_room_id is None
        assert any(i.check == "no_partner_salaried_room" for i in issues)
        assert log.entries == []
