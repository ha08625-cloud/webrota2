from app.engine.context import load_context
from app.engine.phases.phase2 import run_phase2
from app.engine.phases.phase9c import run_phase9c
from app.engine.datatypes import DecisionLog
from app.models.enums import Day, DoctorType, MasterSessionType, Period, RoomType, SystemCounterType

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


class TestSrPriorityPath:
    def test_sr_occupant_assigned_supervisor(self, session, config_1wk):
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
        assert counters.system[(sr_occupant.id, SystemCounterType.SUPERVISION)] == 1
        assert not any(i.phase == "phase9c" for i in issues)

        entries = [e for e in log.entries if e.action == "assign_supervisor"]
        assert len(entries) == 1
        entry = entries[0]
        assert entry.doctor_id == sr_occupant.id
        assert entry.room_id == sr_room.id
        assert entry.week == 1 and entry.day == Day.MONDAY and entry.period == Period.AM
        assert "SR-room occupant" in entry.message
        assert "1 trainee" in entry.message

    def test_sr_occupant_ineligible_falls_through_to_pool(self, session, config_1wk):
        t = make_template(session, is_active=True)
        trainee = make_doctor(session, code="TT", doctor_type=DoctorType.TRAINEE)
        # SR occupant is a Trainee, not Partner/Salaried -- not an eligible
        # supervisor, so the SR-priority path must fall through to the pool.
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

        entries = [e for e in log.entries if e.action == "assign_supervisor"]
        assert len(entries) == 1
        assert entries[0].doctor_id == pool_doctor.id
        assert "eligible pool" in entries[0].message


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
