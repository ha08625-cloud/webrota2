from app.engine.context import load_context
from app.engine.phases.phase2 import run_phase2
from app.engine.phases.phase9c import run_phase9c
from app.engine.datatypes import DecisionLog
from app.models.enums import (
    Day,
    DoctorType,
    MasterSessionType,
    Period,
    RoomType,
    SupervisionPreference,
    SystemCounterType,
)

from .factories import (
    make_doctor,
    make_master_session,
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


class TestSrSwap:
    """There is no SR-priority fast path any more: selection is always by weighted SUPERVISION score across the whole
    D/SR pool. These tests cover the post-selection swap-into-SR step that
    replaced it, including its excluded edge case.
    """

    def test_only_candidate_already_in_sr_no_swap_entry(self, session, config_1wk):
        # Sole eligible doctor happens to sit in SR -- selected via the
        # normal pool path (there is only one candidate), and the swap step
        # is a no-op because they are already where the swap would put them.
        t = make_template(session, is_active=True)
        trainee = make_doctor(session, code="TT", doctor_type=DoctorType.TRAINEE)
        sr_occupant = make_doctor(session, code="PP", doctor_type=DoctorType.PARTNER)
        sr_room = make_room(session, code="SR1", room_type=RoomType.SR)

        _requires_room(session, t, trainee)
        _pre_assigned(session, t, sr_occupant, sr_room)

        ctx, grid, counters = _build(session, config_1wk)
        log = DecisionLog()
        issues = run_phase9c(ctx, grid, counters, log)

        slot = grid.get(sr_occupant.id, 1, Day.MONDAY, Period.AM)
        assert slot.is_supervising is True
        assert slot.assigned_room_id == sr_room.id
        assert counters.system[(sr_occupant.id, SystemCounterType.SUPERVISION)] == 1
        assert not any(i.phase == "phase9c" for i in issues)

        assign_entries = [e for e in log.entries if e.action == "assign_supervisor"]
        assert len(assign_entries) == 1
        assert assign_entries[0].doctor_id == sr_occupant.id
        assert assign_entries[0].room_id == sr_room.id
        assert "only eligible doctor" in assign_entries[0].message

        assert not any(e.action == "swap_supervisor_into_sr" for e in log.entries)

    def test_sr_unoccupied_no_swap(self, session, config_1wk):
        # An SR room exists in the practice but nobody sits in it this
        # session -- the D-room winner has nothing to swap with and stays
        # where they are.
        t = make_template(session, is_active=True)
        trainee = make_doctor(session, code="TT", doctor_type=DoctorType.TRAINEE)
        supervisor = make_doctor(session, code="PP", doctor_type=DoctorType.PARTNER)
        d_room = make_room(session, code="D1", room_type=RoomType.D)
        make_room(session, code="SR1", room_type=RoomType.SR)  # unoccupied this session

        _requires_room(session, t, trainee)
        _pre_assigned(session, t, supervisor, d_room)

        ctx, grid, counters = _build(session, config_1wk)
        log = DecisionLog()
        run_phase9c(ctx, grid, counters, log)

        slot = grid.get(supervisor.id, 1, Day.MONDAY, Period.AM)
        assert slot.is_supervising is True
        assert slot.assigned_room_id == d_room.id
        assert not any(e.action == "swap_supervisor_into_sr" for e in log.entries)

    def test_ineligible_sr_occupant_falls_through_and_is_swapped_out(self, session, config_1wk):
        # SR occupant is a Trainee, not Partner/Salaried -- not an eligible
        # supervisor, so the pool winner is the D-room doctor. That winner
        # is then swapped into SR, displacing the trainee into the vacated
        # D room.
        t = make_template(session, is_active=True)
        trainee = make_doctor(session, code="TT", doctor_type=DoctorType.TRAINEE)
        sr_occupant = make_doctor(session, code="TR", doctor_type=DoctorType.TRAINEE)
        sr_room = make_room(session, code="SR1", room_type=RoomType.SR)
        pool_doctor = make_doctor(session, code="PP", doctor_type=DoctorType.PARTNER)
        d_room = make_room(session, code="D1", room_type=RoomType.D)

        _requires_room(session, t, trainee)
        _pre_assigned(session, t, sr_occupant, sr_room)
        _pre_assigned(session, t, pool_doctor, d_room)

        ctx, grid, counters = _build(session, config_1wk)
        log = DecisionLog()
        run_phase9c(ctx, grid, counters, log)

        assign_entries = [e for e in log.entries if e.action == "assign_supervisor"]
        assert len(assign_entries) == 1
        assert assign_entries[0].doctor_id == pool_doctor.id
        assert "eligible pool" in assign_entries[0].message
        # Recorded at selection time, before the swap moves the room.
        assert assign_entries[0].room_id == d_room.id

        assert grid.get(pool_doctor.id, 1, Day.MONDAY, Period.AM).assigned_room_id == sr_room.id
        assert grid.get(sr_occupant.id, 1, Day.MONDAY, Period.AM).assigned_room_id == d_room.id

        swap_entries = [e for e in log.entries if e.action == "swap_supervisor_into_sr"]
        assert len(swap_entries) == 1
        assert swap_entries[0].doctor_id == pool_doctor.id
        assert swap_entries[0].room_id == sr_room.id

    def test_pool_winner_not_in_sr_swaps_with_sr_occupant(self, session, config_1wk):
        # Plain two-candidate pool win (lower raw SUPERVISION count), then
        # the winner -- sitting in D -- is swapped into SR with the
        # occupant, who takes the winner's vacated D room.
        t = make_template(session, is_active=True)
        trainee = make_doctor(session, code="TT", doctor_type=DoctorType.TRAINEE)
        winner = make_doctor(session, code="AA", doctor_type=DoctorType.PARTNER, spw="10.0")
        sr_occupant = make_doctor(session, code="BB", doctor_type=DoctorType.PARTNER, spw="10.0")
        d_room = make_room(session, code="D1", room_type=RoomType.D)
        sr_room = make_room(session, code="SR1", room_type=RoomType.SR)

        _requires_room(session, t, trainee)
        _pre_assigned(session, t, winner, d_room)
        _pre_assigned(session, t, sr_occupant, sr_room)
        make_system_counter(session, winner, SystemCounterType.SUPERVISION, raw_count=0)
        make_system_counter(session, sr_occupant, SystemCounterType.SUPERVISION, raw_count=5)

        ctx, grid, counters = _build(session, config_1wk)
        log = DecisionLog()
        run_phase9c(ctx, grid, counters, log)

        assert grid.get(winner.id, 1, Day.MONDAY, Period.AM).is_supervising is True
        assert grid.get(sr_occupant.id, 1, Day.MONDAY, Period.AM).is_supervising is False
        assert grid.get(winner.id, 1, Day.MONDAY, Period.AM).assigned_room_id == sr_room.id
        assert grid.get(sr_occupant.id, 1, Day.MONDAY, Period.AM).assigned_room_id == d_room.id

        swap_entries = [e for e in log.entries if e.action == "swap_supervisor_into_sr"]
        assert len(swap_entries) == 1
        assert swap_entries[0].doctor_id == winner.id
        assert "AA" in swap_entries[0].message and "BB" in swap_entries[0].message

    def test_none_preference_sr_occupant_no_longer_auto_assigned(self, session, config_1wk):
        # There is no SR-priority fast path any more, so a "none"-preference
        # doctor sitting in SR gets no special treatment: the preference
        # multiplier still deprioritises them against a lower-scoring D-room
        # candidate, and the D-room candidate wins the pool comparison
        # outright before any swap is considered.
        t = make_template(session, is_active=True)
        trainee = make_doctor(session, code="TT", doctor_type=DoctorType.TRAINEE)
        sr_occupant = make_doctor(
            session, code="PP", doctor_type=DoctorType.PARTNER,
            supervision_preference=SupervisionPreference.NONE,
        )
        sr_room = make_room(session, code="SR1", room_type=RoomType.SR)
        pool_doctor = make_doctor(session, code="QQ", doctor_type=DoctorType.PARTNER)
        d_room = make_room(session, code="D1", room_type=RoomType.D)

        _requires_room(session, t, trainee)
        _pre_assigned(session, t, sr_occupant, sr_room)
        _pre_assigned(session, t, pool_doctor, d_room)
        make_system_counter(session, sr_occupant, SystemCounterType.SUPERVISION, raw_count=1)
        make_system_counter(session, pool_doctor, SystemCounterType.SUPERVISION, raw_count=0)

        ctx, grid, counters = _build(session, config_1wk)
        log = DecisionLog()
        run_phase9c(ctx, grid, counters, log)

        assign_entries = [e for e in log.entries if e.action == "assign_supervisor"]
        assert len(assign_entries) == 1
        assert assign_entries[0].doctor_id == pool_doctor.id

        # Winner was in D, not SR, so the swap step then moves them into SR.
        assert grid.get(pool_doctor.id, 1, Day.MONDAY, Period.AM).assigned_room_id == sr_room.id
        assert grid.get(sr_occupant.id, 1, Day.MONDAY, Period.AM).assigned_room_id == d_room.id
        assert grid.get(sr_occupant.id, 1, Day.MONDAY, Period.AM).is_supervising is False


class TestPoolPath:
    def test_pool_selection_only_eligible_doctor(self, session, config_1wk):
        t = make_template(session, is_active=True)
        trainee = make_doctor(session, code="TT", doctor_type=DoctorType.TRAINEE)
        supervisor = make_doctor(session, code="PP", doctor_type=DoctorType.PARTNER)
        d_room = make_room(session, code="D1", room_type=RoomType.D)

        _requires_room(session, t, trainee)
        _pre_assigned(session, t, supervisor, d_room)

        ctx, grid, counters = _build(session, config_1wk)
        log = DecisionLog()
        run_phase9c(ctx, grid, counters, log)

        slot = grid.get(supervisor.id, 1, Day.MONDAY, Period.AM)
        assert slot.is_supervising is True

        entry = next(e for e in log.entries if e.action == "assign_supervisor")
        assert entry.doctor_id == supervisor.id
        assert entry.room_id == d_room.id
        assert "only eligible doctor" in entry.message

    def test_pool_selection_lowest_weighted_score_wins(self, session, config_1wk):
        t = make_template(session, is_active=True)
        trainee = make_doctor(session, code="TT", doctor_type=DoctorType.TRAINEE)
        low_score = make_doctor(session, code="ZZ", doctor_type=DoctorType.PARTNER, spw="10.0")
        high_score = make_doctor(session, code="AA", doctor_type=DoctorType.PARTNER, spw="10.0")
        room_low = make_room(session, code="D1", room_type=RoomType.D)
        room_high = make_room(session, code="D2", room_type=RoomType.D)

        _requires_room(session, t, trainee)
        _pre_assigned(session, t, low_score, room_low)
        _pre_assigned(session, t, high_score, room_high)
        make_system_counter(session, low_score, SystemCounterType.SUPERVISION, raw_count=0)
        make_system_counter(session, high_score, SystemCounterType.SUPERVISION, raw_count=5)

        ctx, grid, counters = _build(session, config_1wk)
        log = DecisionLog()
        run_phase9c(ctx, grid, counters, log)

        assert grid.get(low_score.id, 1, Day.MONDAY, Period.AM).is_supervising is True
        assert grid.get(high_score.id, 1, Day.MONDAY, Period.AM).is_supervising is False

        entry = next(e for e in log.entries if e.action == "assign_supervisor")
        assert entry.doctor_id == low_score.id
        assert "lowest weighted supervision score" in entry.message

    def test_pool_selection_preference_flips_raw_score_order(self, session, config_1wk):
        # raw_lower has the lower raw SUPERVISION count and would win on an
        # unweighted comparison. A "less" preference on raw_lower (x1.5) and
        # a "more" preference on raw_higher (x0.66) flips the weighted
        # comparison so raw_higher wins instead - this is the case the
        # multiplier exists for.
        t = make_template(session, is_active=True)
        trainee = make_doctor(session, code="TT", doctor_type=DoctorType.TRAINEE)
        raw_lower = make_doctor(
            session, code="ZZ", doctor_type=DoctorType.PARTNER, spw="10.0",
            supervision_preference=SupervisionPreference.LESS,
        )
        raw_higher = make_doctor(
            session, code="AA", doctor_type=DoctorType.PARTNER, spw="10.0",
            supervision_preference=SupervisionPreference.MORE,
        )
        room_lower = make_room(session, code="D1", room_type=RoomType.D)
        room_higher = make_room(session, code="D2", room_type=RoomType.D)

        _requires_room(session, t, trainee)
        _pre_assigned(session, t, raw_lower, room_lower)
        _pre_assigned(session, t, raw_higher, room_higher)
        # Unweighted: raw_lower = 1/10 = 0.1, raw_higher = 2/10 = 0.2 --
        # raw_lower would win on raw score alone.
        make_system_counter(session, raw_lower, SystemCounterType.SUPERVISION, raw_count=1)
        make_system_counter(session, raw_higher, SystemCounterType.SUPERVISION, raw_count=2)
        # Weighted: raw_lower = 0.1 * 1.5 = 0.15, raw_higher = 0.2 * 0.66 = 0.132 --
        # the preference multiplier flips the winner to raw_higher.

        ctx, grid, counters = _build(session, config_1wk)
        log = DecisionLog()
        run_phase9c(ctx, grid, counters, log)

        assert grid.get(raw_higher.id, 1, Day.MONDAY, Period.AM).is_supervising is True
        assert grid.get(raw_lower.id, 1, Day.MONDAY, Period.AM).is_supervising is False

        entry = next(e for e in log.entries if e.action == "assign_supervisor")
        assert entry.doctor_id == raw_higher.id
        assert "preference-adjusted" in entry.message

    def test_pool_selection_lone_none_preference_doctor_still_assigned(self, session, config_1wk):
        # The multiplier deprioritises, it does not exclude: a "none"
        # preference doctor is still selected when they are the sole
        # eligible candidate for the session.
        t = make_template(session, is_active=True)
        trainee = make_doctor(session, code="TT", doctor_type=DoctorType.TRAINEE)
        only_candidate = make_doctor(
            session, code="PP", doctor_type=DoctorType.PARTNER,
            supervision_preference=SupervisionPreference.NONE,
        )
        d_room = make_room(session, code="D1", room_type=RoomType.D)

        _requires_room(session, t, trainee)
        _pre_assigned(session, t, only_candidate, d_room)

        ctx, grid, counters = _build(session, config_1wk)
        log = DecisionLog()
        issues = run_phase9c(ctx, grid, counters, log)

        assert not any(i.check == "supervision_unassignable" for i in issues)
        slot = grid.get(only_candidate.id, 1, Day.MONDAY, Period.AM)
        assert slot.is_supervising is True
        assert counters.system[(only_candidate.id, SystemCounterType.SUPERVISION)] == 1

        entry = next(e for e in log.entries if e.action == "assign_supervisor")
        assert entry.doctor_id == only_candidate.id
        assert "only eligible doctor" in entry.message

    def test_pool_selection_explicit_normal_preference_matches_unweighted_score(self, session, config_1wk):
        # Regression guard: an explicit "normal" preference (multiplier 1.0)
        # must select on the raw score alone, same as before this feature
        # existed, and the log message must not claim a preference
        # adjustment happened.
        t = make_template(session, is_active=True)
        trainee = make_doctor(session, code="TT", doctor_type=DoctorType.TRAINEE)
        low_score = make_doctor(
            session, code="ZZ", doctor_type=DoctorType.PARTNER, spw="10.0",
            supervision_preference=SupervisionPreference.NORMAL,
        )
        high_score = make_doctor(
            session, code="AA", doctor_type=DoctorType.PARTNER, spw="10.0",
            supervision_preference=SupervisionPreference.NORMAL,
        )
        room_low = make_room(session, code="D1", room_type=RoomType.D)
        room_high = make_room(session, code="D2", room_type=RoomType.D)

        _requires_room(session, t, trainee)
        _pre_assigned(session, t, low_score, room_low)
        _pre_assigned(session, t, high_score, room_high)
        make_system_counter(session, low_score, SystemCounterType.SUPERVISION, raw_count=0)
        make_system_counter(session, high_score, SystemCounterType.SUPERVISION, raw_count=5)

        ctx, grid, counters = _build(session, config_1wk)
        log = DecisionLog()
        run_phase9c(ctx, grid, counters, log)

        assert grid.get(low_score.id, 1, Day.MONDAY, Period.AM).is_supervising is True
        entry = next(e for e in log.entries if e.action == "assign_supervisor")
        assert "preference-adjusted" not in entry.message


class TestNoSupervisorAvailable:
    def test_no_eligible_supervisor_warns_and_logs_nothing(self, session, config_1wk):
        t = make_template(session, is_active=True)
        trainee = make_doctor(session, code="TT", doctor_type=DoctorType.TRAINEE)
        _requires_room(session, t, trainee)
        # No Partner/Salaried doctor exists at all.

        ctx, grid, counters = _build(session, config_1wk)
        log = DecisionLog()
        issues = run_phase9c(ctx, grid, counters, log)

        assert any(i.check == "supervision_unassignable" for i in issues)
        assert log.entries == []


class TestNoTraineesSkipsSession:
    def test_no_supervisable_trainee_no_entries(self, session, config_1wk):
        t = make_template(session, is_active=True)
        supervisor = make_doctor(session, code="PP", doctor_type=DoctorType.PARTNER)
        d_room = make_room(session, code="D1", room_type=RoomType.D)
        _pre_assigned(session, t, supervisor, d_room)
        # No trainee at all -- n == 0 for every session, phase should be a no-op.

        ctx, grid, counters = _build(session, config_1wk)
        log = DecisionLog()
        issues = run_phase9c(ctx, grid, counters, log)

        assert issues == []
        assert log.entries == []