from app.engine.context import load_context
from app.engine.phases.phase2 import run_phase2
from app.engine.phases.phase4 import run_phase4
from app.engine.datatypes import DecisionLog
from app.models import RotaConfig
from app.models.enums import Day, DutyType, MasterSessionType, Period, SessionRole

from .factories import make_doctor, make_duty, make_master_session, make_room, make_template


def _build(session, config):
    ctx = load_context(session, config)
    grid, counters = run_phase2(ctx, config, session)
    return ctx, grid


class TestDutyRoleApplied:
    def test_primary_duty_sets_role(self, session, config_1wk, monday):
        t = make_template(session, is_active=True)
        d = make_doctor(session, code="AA")
        make_master_session(
            session, t, d, week=1, day=Day.MONDAY, period=Period.AM,
            session_type=MasterSessionType.REQUIRES_ROOM,
        )
        make_duty(session, monday, Period.AM, d, DutyType.PRIMARY)

        ctx, grid = _build(session, config_1wk)
        log = DecisionLog()
        issues = run_phase4(ctx, grid, log)

        slot = grid.get(d.id, 1, Day.MONDAY, Period.AM)
        assert slot.role == SessionRole.DUTY_PRIMARY
        assert issues == []

    def test_secondary_duty_sets_role(self, session, config_1wk, monday):
        t = make_template(session, is_active=True)
        d = make_doctor(session, code="AA")
        make_master_session(
            session, t, d, week=1, day=Day.MONDAY, period=Period.AM,
            session_type=MasterSessionType.REQUIRES_ROOM,
        )
        make_duty(session, monday, Period.AM, d, DutyType.SECONDARY)

        ctx, grid = _build(session, config_1wk)
        log = DecisionLog()
        issues = run_phase4(ctx, grid, log)

        slot = grid.get(d.id, 1, Day.MONDAY, Period.AM)
        assert slot.role == SessionRole.DUTY_SECONDARY
        assert issues == []

    def test_duty_does_not_touch_existing_room(self, session, config_1wk, monday):
        t = make_template(session, is_active=True)
        d = make_doctor(session, code="AA")
        room = make_room(session, code="D1")
        make_master_session(
            session, t, d, week=1, day=Day.MONDAY, period=Period.AM,
            session_type=MasterSessionType.PRE_ASSIGNED, room=room,
        )
        make_duty(session, monday, Period.AM, d, DutyType.PRIMARY)

        ctx, grid = _build(session, config_1wk)
        log = DecisionLog()
        run_phase4(ctx, grid, log)

        slot = grid.get(d.id, 1, Day.MONDAY, Period.AM)
        assert slot.role == SessionRole.DUTY_PRIMARY
        assert slot.assigned_room_id == room.id  # unchanged by duty

    def test_multiple_doctors_independent(self, session, config_1wk, monday):
        t = make_template(session, is_active=True)
        d1 = make_doctor(session, code="AA")
        d2 = make_doctor(session, code="BB")
        for d in (d1, d2):
            make_master_session(
                session, t, d, week=1, day=Day.MONDAY, period=Period.AM,
                session_type=MasterSessionType.REQUIRES_ROOM,
            )
        make_duty(session, monday, Period.AM, d1, DutyType.PRIMARY)
        make_duty(session, monday, Period.AM, d2, DutyType.SECONDARY)

        ctx, grid = _build(session, config_1wk)
        log = DecisionLog()
        run_phase4(ctx, grid, log)

        assert grid.get(d1.id, 1, Day.MONDAY, Period.AM).role == SessionRole.DUTY_PRIMARY
        assert grid.get(d2.id, 1, Day.MONDAY, Period.AM).role == SessionRole.DUTY_SECONDARY


class TestDutyWarnings:
    def test_no_session_slot_warns(self, session, config_1wk, monday):
        make_template(session, is_active=True)
        d = make_doctor(session, code="AA")
        # No MasterRotaSession row at all for this doctor/day/period.
        make_duty(session, monday, Period.AM, d, DutyType.PRIMARY)

        ctx, grid = _build(session, config_1wk)
        log = DecisionLog()
        issues = run_phase4(ctx, grid, log)

        assert len(issues) == 1
        assert issues[0].check == "duty_no_session_slot"
        assert issues[0].severity == "warning"
        assert log.entries == []  # no decision was made -- only a warning

    def test_conflicting_duty_roles_keeps_first_and_warns(self, session, config_1wk, monday):
        t = make_template(session, is_active=True)
        d = make_doctor(session, code="AA")
        make_master_session(
            session, t, d, week=1, day=Day.MONDAY, period=Period.AM,
            session_type=MasterSessionType.REQUIRES_ROOM,
        )
        # Same doctor given both primary and secondary duty in the same slot.
        make_duty(session, monday, Period.AM, d, DutyType.PRIMARY)
        make_duty(session, monday, Period.AM, d, DutyType.SECONDARY)

        ctx, grid = _build(session, config_1wk)
        log = DecisionLog()
        issues = run_phase4(ctx, grid, log)

        slot = grid.get(d.id, 1, Day.MONDAY, Period.AM)
        # "primary" sorts before "secondary" alphabetically -> applied first.
        assert slot.role == SessionRole.DUTY_PRIMARY
        assert len(issues) == 1
        assert issues[0].check == "duty_role_conflict"
        assert issues[0].severity == "warning"
        # Exactly one decision was made (the primary duty); the rejected
        # secondary duty produced a warning, not a log entry.
        assert len(log.entries) == 1
        assert log.entries[0].action == "assign_duty"


class TestDecisionLog:
    def test_assign_duty_entry_recorded(self, session, config_1wk, monday):
        t = make_template(session, is_active=True)
        d = make_doctor(session, code="AA")
        make_master_session(
            session, t, d, week=1, day=Day.MONDAY, period=Period.AM,
            session_type=MasterSessionType.REQUIRES_ROOM,
        )
        make_duty(session, monday, Period.AM, d, DutyType.PRIMARY)

        ctx, grid = _build(session, config_1wk)
        log = DecisionLog()
        run_phase4(ctx, grid, log)

        assert len(log.entries) == 1
        entry = log.entries[0]
        assert entry.phase == "phase4"
        assert entry.action == "assign_duty"
        assert entry.week == 1
        assert entry.day == Day.MONDAY
        assert entry.period == Period.AM
        assert entry.doctor_id == d.id
        assert "AA" in entry.message
        assert "primary" in entry.message

    def test_sequence_is_monotonic_across_multiple_duties(self, session, config_1wk, monday):
        t = make_template(session, is_active=True)
        d1 = make_doctor(session, code="AA")
        d2 = make_doctor(session, code="BB")
        for d in (d1, d2):
            make_master_session(
                session, t, d, week=1, day=Day.MONDAY, period=Period.AM,
                session_type=MasterSessionType.REQUIRES_ROOM,
            )
        make_duty(session, monday, Period.AM, d1, DutyType.PRIMARY)
        make_duty(session, monday, Period.AM, d2, DutyType.SECONDARY)

        ctx, grid = _build(session, config_1wk)
        log = DecisionLog()
        run_phase4(ctx, grid, log)

        assert [e.sequence for e in log.entries] == list(range(len(log.entries)))
        assert len(log.entries) == 2
