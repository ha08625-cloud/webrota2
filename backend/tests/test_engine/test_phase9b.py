from app.engine.context import load_context
from app.engine.phases.phase2 import run_phase2
from app.engine.phases.phase9b import run_phase9b
from app.models.enums import Day, DoctorType, MasterSessionType, Period, RoomType

from .factories import (
    make_doctor,
    make_leave,
    make_master_session,
    make_preferred_room,
    make_room,
    make_template,
)


def _pre_assigned(session, template, doctor, room, week=1, day=Day.MONDAY, period=Period.AM):
    make_master_session(
        session, template, doctor, week=week, day=day, period=period,
        session_type=MasterSessionType.PRE_ASSIGNED, room=room,
    )


def _no_surgery(session, template, doctor, week=1, day=Day.MONDAY, period=Period.AM):
    make_master_session(
        session, template, doctor, week=week, day=day, period=period,
        session_type=MasterSessionType.NO_SURGERY,
    )


def _requires_room_unresolved(session, template, doctor, week=1, day=Day.MONDAY, period=Period.AM):
    make_master_session(
        session, template, doctor, week=week, day=day, period=period,
        session_type=MasterSessionType.REQUIRES_ROOM,
    )


def _build(session, config):
    """Build context+grid. Must be called only AFTER every fixture row for
    this test (doctors, sessions, preferences, leave) has been created --
    GenerationContext is an immutable snapshot taken at load_context() time,
    so anything added afterward is invisible to it."""
    ctx = load_context(session, config)
    grid, counters = run_phase2(ctx, config, session)
    return ctx, grid


def _setup_swap(session, a_type=DoctorType.PARTNER, b_type=DoctorType.SALARIED):
    """A: AM=X, PM=Y. B: AM=Y, PM=X -- an exact swap.

    Does NOT build the context/grid -- call _build() after adding any
    per-test preferences/leave, so load_context() sees them.
    Returns (template, a, b, x, y).
    """
    t = make_template(session, is_active=True)
    a = make_doctor(session, code="AA", doctor_type=a_type)
    b = make_doctor(session, code="BB", doctor_type=b_type)
    x = make_room(session, code="C1", room_type=RoomType.C)
    y = make_room(session, code="C2", room_type=RoomType.C)
    _pre_assigned(session, t, a, x, period=Period.AM)
    _pre_assigned(session, t, a, y, period=Period.PM)
    _pre_assigned(session, t, b, y, period=Period.AM)
    _pre_assigned(session, t, b, x, period=Period.PM)
    return t, a, b, x, y


class TestDefaultRows:
    def test_row1_only_a_prefers_own_room(self, session, config_1wk):
        t, a, b, x, y = _setup_swap(session)
        make_preferred_room(session, a, preference_order=1, room=x)  # A prefers own (X)
        # B has no preferences at all

        ctx, grid = _build(session, config_1wk)
        run_phase9b(ctx, grid)

        assert grid.get(a.id, 1, Day.MONDAY, Period.AM).assigned_room_id == x.id  # AM unchanged
        assert grid.get(b.id, 1, Day.MONDAY, Period.AM).assigned_room_id == y.id  # AM unchanged
        assert grid.get(a.id, 1, Day.MONDAY, Period.PM).assigned_room_id == x.id  # reverted
        assert grid.get(b.id, 1, Day.MONDAY, Period.PM).assigned_room_id == y.id  # reverted

    def test_row2_only_b_prefers_own_room(self, session, config_1wk):
        t, a, b, x, y = _setup_swap(session)
        make_preferred_room(session, b, preference_order=1, room=y)  # B prefers own (Y)

        ctx, grid = _build(session, config_1wk)
        run_phase9b(ctx, grid)

        assert grid.get(a.id, 1, Day.MONDAY, Period.PM).assigned_room_id == x.id  # reverted
        assert grid.get(b.id, 1, Day.MONDAY, Period.PM).assigned_room_id == y.id  # reverted

    def test_row6_same_room_same_type_defaults(self, session, config_1wk):
        t, a, b, x, y = _setup_swap(
            session, a_type=DoctorType.PARTNER, b_type=DoctorType.PARTNER,
        )
        make_preferred_room(session, a, preference_order=1, room=y)  # A prefers other (Y)
        make_preferred_room(session, b, preference_order=1, room=y)  # B prefers own (Y) -- same room, same type

        ctx, grid = _build(session, config_1wk)
        run_phase9b(ctx, grid)

        assert grid.get(a.id, 1, Day.MONDAY, Period.PM).assigned_room_id == x.id  # reverted
        assert grid.get(b.id, 1, Day.MONDAY, Period.PM).assigned_room_id == y.id  # reverted

    def test_row7_no_preferences_defaults(self, session, config_1wk):
        t, a, b, x, y = _setup_swap(session)
        # neither doctor has any preferred rooms at all

        ctx, grid = _build(session, config_1wk)
        run_phase9b(ctx, grid)

        assert grid.get(a.id, 1, Day.MONDAY, Period.PM).assigned_room_id == x.id
        assert grid.get(b.id, 1, Day.MONDAY, Period.PM).assigned_room_id == y.id


class TestConfirmRows:
    def test_row3_only_a_prefers_other_room(self, session, config_1wk):
        t, a, b, x, y = _setup_swap(session)
        make_preferred_room(session, a, preference_order=1, room=y)  # A prefers other (Y)

        ctx, grid = _build(session, config_1wk)
        run_phase9b(ctx, grid)

        assert grid.get(a.id, 1, Day.MONDAY, Period.PM).assigned_room_id == y.id  # unchanged (confirmed)
        assert grid.get(b.id, 1, Day.MONDAY, Period.PM).assigned_room_id == x.id  # unchanged (confirmed)

    def test_row4_only_b_prefers_other_room(self, session, config_1wk):
        t, a, b, x, y = _setup_swap(session)
        make_preferred_room(session, b, preference_order=1, room=x)  # B prefers other (X)

        ctx, grid = _build(session, config_1wk)
        run_phase9b(ctx, grid)

        assert grid.get(a.id, 1, Day.MONDAY, Period.PM).assigned_room_id == y.id  # confirmed
        assert grid.get(b.id, 1, Day.MONDAY, Period.PM).assigned_room_id == x.id  # confirmed


class TestRow5DroppedCollapsesToDefault:
    """Row 5 ('both prefer the same room; Partner wins') was dropped -- see
    phase9b.py module docstring. Its scenario (one doctor prefers the other
    room, the other doctor prefers their own room) is captured by row 1/2
    before it would ever be reached, so it always defaults regardless of
    doctor type."""

    def test_same_room_y_defaults_regardless_of_partner_type_a(self, session, config_1wk):
        t, a, b, x, y = _setup_swap(
            session, a_type=DoctorType.PARTNER, b_type=DoctorType.SALARIED,
        )
        make_preferred_room(session, a, preference_order=1, room=y)  # A prefers other (Y)
        make_preferred_room(session, b, preference_order=1, room=y)  # B prefers own (Y)

        ctx, grid = _build(session, config_1wk)
        run_phase9b(ctx, grid)

        # row 2 fires first ("only B prefers own room") -> default, regardless
        # of A being the Partner
        assert grid.get(a.id, 1, Day.MONDAY, Period.PM).assigned_room_id == x.id
        assert grid.get(b.id, 1, Day.MONDAY, Period.PM).assigned_room_id == y.id

    def test_same_room_y_defaults_regardless_of_partner_type_b(self, session, config_1wk):
        t, a, b, x, y = _setup_swap(
            session, a_type=DoctorType.SALARIED, b_type=DoctorType.PARTNER,
        )
        make_preferred_room(session, a, preference_order=1, room=y)  # A prefers other (Y)
        make_preferred_room(session, b, preference_order=1, room=y)  # B prefers own (Y)

        ctx, grid = _build(session, config_1wk)
        run_phase9b(ctx, grid)

        assert grid.get(a.id, 1, Day.MONDAY, Period.PM).assigned_room_id == x.id
        assert grid.get(b.id, 1, Day.MONDAY, Period.PM).assigned_room_id == y.id

    def test_same_room_x_defaults_regardless_of_partner_type(self, session, config_1wk):
        t, a, b, x, y = _setup_swap(
            session, a_type=DoctorType.SALARIED, b_type=DoctorType.PARTNER,
        )
        make_preferred_room(session, a, preference_order=1, room=x)  # A prefers own (X)
        make_preferred_room(session, b, preference_order=1, room=x)  # B prefers other (X)

        ctx, grid = _build(session, config_1wk)
        run_phase9b(ctx, grid)

        # row 1 fires first ("only A prefers own room") -> default
        assert grid.get(a.id, 1, Day.MONDAY, Period.PM).assigned_room_id == x.id
        assert grid.get(b.id, 1, Day.MONDAY, Period.PM).assigned_room_id == y.id


class TestSkipConditions:
    def test_leave_pair_skipped_entirely(self, session, config_1wk, monday):
        t, a, b, x, y = _setup_swap(session)
        make_leave(session, a, monday, Period.AM)

        ctx, grid = _build(session, config_1wk)
        run_phase9b(ctx, grid)  # should not raise, pair skipped

        # untouched -- still whatever Phase 2 set (the "swapped" PRE_ASSIGNED values)
        assert grid.get(a.id, 1, Day.MONDAY, Period.PM).assigned_room_id == y.id
        assert grid.get(b.id, 1, Day.MONDAY, Period.PM).assigned_room_id == x.id

    def test_no_surgery_pair_skipped(self, session, config_1wk):
        t = make_template(session, is_active=True)
        a = make_doctor(session, code="AA", doctor_type=DoctorType.PARTNER)
        b = make_doctor(session, code="BB", doctor_type=DoctorType.SALARIED)
        x = make_room(session, code="C1", room_type=RoomType.C)
        y = make_room(session, code="C2", room_type=RoomType.C)
        _no_surgery(session, t, a, period=Period.AM)
        _pre_assigned(session, t, a, y, period=Period.PM)
        _pre_assigned(session, t, b, y, period=Period.AM)
        _pre_assigned(session, t, b, x, period=Period.PM)

        ctx, grid = _build(session, config_1wk)
        run_phase9b(ctx, grid)  # should not raise

        assert grid.get(b.id, 1, Day.MONDAY, Period.PM).assigned_room_id == x.id  # untouched

    def test_unresolved_session_pair_skipped(self, session, config_1wk):
        t = make_template(session, is_active=True)
        a = make_doctor(session, code="AA", doctor_type=DoctorType.PARTNER)
        b = make_doctor(session, code="BB", doctor_type=DoctorType.SALARIED)
        y = make_room(session, code="C2", room_type=RoomType.C)
        x = make_room(session, code="C1", room_type=RoomType.C)
        _requires_room_unresolved(session, t, a, period=Period.AM)  # unresolved
        _pre_assigned(session, t, a, y, period=Period.PM)
        _pre_assigned(session, t, b, y, period=Period.AM)
        _pre_assigned(session, t, b, x, period=Period.PM)

        ctx, grid = _build(session, config_1wk)
        run_phase9b(ctx, grid)  # should not raise

        assert grid.get(a.id, 1, Day.MONDAY, Period.AM).assigned_room_id is None


class TestNonSwapsUntouched:
    def test_non_matching_pair_untouched(self, session, config_1wk):
        t = make_template(session, is_active=True)
        a = make_doctor(session, code="AA", doctor_type=DoctorType.PARTNER)
        b = make_doctor(session, code="BB", doctor_type=DoctorType.SALARIED)
        r1 = make_room(session, code="C1", room_type=RoomType.C)
        r2 = make_room(session, code="C2", room_type=RoomType.C)
        r3 = make_room(session, code="C3", room_type=RoomType.C)
        _pre_assigned(session, t, a, r1, period=Period.AM)
        _pre_assigned(session, t, a, r2, period=Period.PM)
        _pre_assigned(session, t, b, r3, period=Period.AM)  # not r2 -- no swap
        _pre_assigned(session, t, b, r1, period=Period.PM)

        ctx, grid = _build(session, config_1wk)
        run_phase9b(ctx, grid)

        assert grid.get(a.id, 1, Day.MONDAY, Period.PM).assigned_room_id == r2.id
        assert grid.get(b.id, 1, Day.MONDAY, Period.PM).assigned_room_id == r1.id

    def test_trainee_ahp_not_considered_even_if_pattern_matches(self, session, config_1wk):
        t = make_template(session, is_active=True)
        a = make_doctor(session, code="AA", doctor_type=DoctorType.TRAINEE)
        b = make_doctor(session, code="BB", doctor_type=DoctorType.AHP)
        x = make_room(session, code="D1", room_type=RoomType.D)
        y = make_room(session, code="D2", room_type=RoomType.D)
        _pre_assigned(session, t, a, x, period=Period.AM)
        _pre_assigned(session, t, a, y, period=Period.PM)
        _pre_assigned(session, t, b, y, period=Period.AM)
        _pre_assigned(session, t, b, x, period=Period.PM)

        ctx, grid = _build(session, config_1wk)
        run_phase9b(ctx, grid)

        # untouched -- Trainee/AHP are never part of Phase 9B's pool
        assert grid.get(a.id, 1, Day.MONDAY, Period.PM).assigned_room_id == y.id
        assert grid.get(b.id, 1, Day.MONDAY, Period.PM).assigned_room_id == x.id


class TestNoIssuesEmitted:
    def test_never_returns_issues(self, session, config_1wk):
        t, a, b, x, y = _setup_swap(session)
        ctx, grid = _build(session, config_1wk)
        issues = run_phase9b(ctx, grid)
        assert issues == []
