import datetime

from app.engine.context import load_context
from app.engine.phases.phase2 import run_phase2
from app.models import RotaConfig
from app.models.enums import Day, MasterSessionType, Period, SystemCounterType

from .factories import (
    make_clinic_counter,
    make_clinic_type,
    make_closure,
    make_doctor,
    make_leave,
    make_master_session,
    make_room,
    make_system_counter,
    make_template,
)

_DAYS = (Day.MONDAY, Day.TUESDAY, Day.WEDNESDAY, Day.THURSDAY, Day.FRIDAY)
_PERIODS = (Period.AM, Period.PM)


def _fill_template_week(session, template, doctor, week, session_type=MasterSessionType.NO_SURGERY, room=None):
    """Create a MasterRotaSession row for every day/period in one template week."""
    for day in _DAYS:
        for period in _PERIODS:
            make_master_session(
                session, template, doctor, week=week, day=day, period=period,
                session_type=session_type, room=room,
            )


class TestGridCoverage:
    def test_full_coverage_for_num_weeks_doctors_days_periods(self, session, monday):
        t = make_template(session, is_active=True)
        d1 = make_doctor(session, code="AA")
        d2 = make_doctor(session, code="BB")
        for d in (d1, d2):
            _fill_template_week(session, t, d, week=1)
            _fill_template_week(session, t, d, week=2)

        config = RotaConfig(start_date=monday, num_weeks=2, template_start_week=1)
        ctx = load_context(session, config)
        grid, counters = run_phase2(ctx, config, session)

        assert len(grid.slots) == 2 * 2 * 5 * 2  # num_weeks * doctors * days * periods

    def test_missing_template_entry_produces_no_slot(self, session, monday):
        t = make_template(session, is_active=True)
        d = make_doctor(session, code="AA")
        # Only Monday AM has a row -- everything else is absent.
        make_master_session(session, t, d, week=1, day=Day.MONDAY, period=Period.AM)

        config = RotaConfig(start_date=monday, num_weeks=1, template_start_week=1)
        ctx = load_context(session, config)
        grid, counters = run_phase2(ctx, config, session)

        assert len(grid.slots) == 1
        assert grid.get(d.id, 1, Day.MONDAY, Period.AM) is not None
        assert grid.get(d.id, 1, Day.MONDAY, Period.PM) is None


class TestDoctorDateWindow:
    """Employment window enforcement in _build_grid: an out-of-window
    (doctor, date) gets no slot
    at all, the same "cell absence is data" mechanism as a missing template
    row or a closed slot."""

    def _one_week_grid(self, session, monday, doctor):
        config = RotaConfig(start_date=monday, num_weeks=1, template_start_week=1)
        ctx = load_context(session, config)
        grid, _counters = run_phase2(ctx, config, session)
        return grid

    def test_null_window_is_unchanged(self, session, monday):
        t = make_template(session, is_active=True)
        d = make_doctor(session, code="AA")
        _fill_template_week(session, t, d, week=1)

        grid = self._one_week_grid(session, monday, d)

        assert len(grid.slots) == 5 * 2

    def test_start_date_after_range_produces_no_slots(self, session, monday):
        t = make_template(session, is_active=True)
        d = make_doctor(
            session, code="AA", start_date=monday + datetime.timedelta(days=7)
        )
        _fill_template_week(session, t, d, week=1)

        grid = self._one_week_grid(session, monday, d)

        assert grid.slots == {}

    def test_start_date_mid_range_produces_slots_from_that_date_on(
        self, session, monday
    ):
        t = make_template(session, is_active=True)
        wednesday = monday + datetime.timedelta(days=2)
        d = make_doctor(session, code="AA", start_date=wednesday)
        _fill_template_week(session, t, d, week=1)

        grid = self._one_week_grid(session, monday, d)

        assert grid.get(d.id, 1, Day.TUESDAY, Period.PM) is None
        assert grid.get(d.id, 1, Day.WEDNESDAY, Period.AM) is not None
        assert grid.get(d.id, 1, Day.FRIDAY, Period.PM) is not None
        assert len(grid.slots) == 3 * 2  # Wed, Thu, Fri

    def test_end_date_mid_range_produces_slots_up_to_that_date(self, session, monday):
        t = make_template(session, is_active=True)
        tuesday = monday + datetime.timedelta(days=1)
        d = make_doctor(session, code="AA", end_date=tuesday)
        _fill_template_week(session, t, d, week=1)

        grid = self._one_week_grid(session, monday, d)

        assert grid.get(d.id, 1, Day.TUESDAY, Period.PM) is not None
        assert grid.get(d.id, 1, Day.WEDNESDAY, Period.AM) is None
        assert len(grid.slots) == 2 * 2  # Mon, Tue

    def test_window_boundaries_are_inclusive(self, session, monday):
        t = make_template(session, is_active=True)
        d = make_doctor(session, code="AA", start_date=monday, end_date=monday)
        _fill_template_week(session, t, d, week=1)

        grid = self._one_week_grid(session, monday, d)

        assert grid.get(d.id, 1, Day.MONDAY, Period.AM) is not None
        assert grid.get(d.id, 1, Day.MONDAY, Period.PM) is not None
        assert grid.get(d.id, 1, Day.TUESDAY, Period.AM) is None

    def test_window_applies_per_doctor(self, session, monday):
        t = make_template(session, is_active=True)
        leaver = make_doctor(session, code="AA", end_date=monday)
        stayer = make_doctor(session, code="BB")
        for d in (leaver, stayer):
            _fill_template_week(session, t, d, week=1)

        grid = self._one_week_grid(session, monday, leaver)

        assert grid.get(leaver.id, 1, Day.FRIDAY, Period.AM) is None
        assert grid.get(stayer.id, 1, Day.FRIDAY, Period.AM) is not None

    def test_window_composes_with_closure_rather_than_overriding_it(
        self, session, monday
    ):
        t = make_template(session, is_active=True)
        wednesday = monday + datetime.timedelta(days=2)
        d = make_doctor(session, code="AA", start_date=wednesday)
        _fill_template_week(session, t, d, week=1)
        # Thursday AM closed: in window, but still no slot.
        make_closure(
            session, monday + datetime.timedelta(days=3), period=Period.AM
        )

        grid = self._one_week_grid(session, monday, d)

        assert grid.get(d.id, 1, Day.THURSDAY, Period.AM) is None  # closed
        assert grid.get(d.id, 1, Day.THURSDAY, Period.PM) is not None  # open, in window
        assert grid.get(d.id, 1, Day.TUESDAY, Period.AM) is None  # out of window
        assert len(grid.slots) == 3 * 2 - 1  # Wed/Thu/Fri, less the closed Thu AM


class TestIsOnLeave:
    def test_leave_matches_flagged_others_not(self, session, monday):
        t = make_template(session, is_active=True)
        d = make_doctor(session, code="AA")
        _fill_template_week(session, t, d, week=1)
        make_leave(session, d, monday, Period.AM)  # Monday AM only

        config = RotaConfig(start_date=monday, num_weeks=1, template_start_week=1)
        ctx = load_context(session, config)
        grid, counters = run_phase2(ctx, config, session)

        assert grid.get(d.id, 1, Day.MONDAY, Period.AM).is_on_leave is True
        assert grid.get(d.id, 1, Day.MONDAY, Period.PM).is_on_leave is False
        assert grid.get(d.id, 1, Day.TUESDAY, Period.AM).is_on_leave is False


class TestIsWfh:
    def test_wfh_template_type_sets_flag(self, session, monday):
        t = make_template(session, is_active=True)
        d = make_doctor(session, code="AA")
        make_master_session(
            session, t, d, week=1, day=Day.MONDAY, period=Period.AM,
            session_type=MasterSessionType.WFH,
        )
        make_master_session(
            session, t, d, week=1, day=Day.MONDAY, period=Period.PM,
            session_type=MasterSessionType.NO_SURGERY,
        )

        config = RotaConfig(start_date=monday, num_weeks=1, template_start_week=1)
        ctx = load_context(session, config)
        grid, counters = run_phase2(ctx, config, session)

        assert grid.get(d.id, 1, Day.MONDAY, Period.AM).is_wfh is True
        assert grid.get(d.id, 1, Day.MONDAY, Period.PM).is_wfh is False


class TestOccupancyInitialisation:
    def test_pre_assigned_with_room_occupies(self, session, monday):
        t = make_template(session, is_active=True)
        d = make_doctor(session, code="AA")
        room = make_room(session, code="D1")
        make_master_session(
            session, t, d, week=1, day=Day.MONDAY, period=Period.AM,
            session_type=MasterSessionType.PRE_ASSIGNED, room=room,
        )

        config = RotaConfig(start_date=monday, num_weeks=1, template_start_week=1)
        ctx = load_context(session, config)
        grid, counters = run_phase2(ctx, config, session)

        slot = grid.get(d.id, 1, Day.MONDAY, Period.AM)
        assert slot.assigned_room_id == room.id
        assert grid.is_room_free(1, Day.MONDAY, Period.AM, room.id) is False

    def test_admin_time_with_room_occupies(self, session, monday):
        t = make_template(session, is_active=True)
        d = make_doctor(session, code="AA")
        room = make_room(session, code="D7")
        make_master_session(
            session, t, d, week=1, day=Day.MONDAY, period=Period.AM,
            session_type=MasterSessionType.ADMIN_TIME, room=room,
        )

        config = RotaConfig(start_date=monday, num_weeks=1, template_start_week=1)
        ctx = load_context(session, config)
        grid, counters = run_phase2(ctx, config, session)

        slot = grid.get(d.id, 1, Day.MONDAY, Period.AM)
        assert slot.assigned_room_id == room.id
        assert grid.is_room_free(1, Day.MONDAY, Period.AM, room.id) is False

    def test_admin_time_without_room_no_occupancy(self, session, monday):
        t = make_template(session, is_active=True)
        d = make_doctor(session, code="AA")
        make_master_session(
            session, t, d, week=1, day=Day.MONDAY, period=Period.AM,
            session_type=MasterSessionType.ADMIN_TIME, room=None,
        )

        config = RotaConfig(start_date=monday, num_weeks=1, template_start_week=1)
        ctx = load_context(session, config)
        grid, counters = run_phase2(ctx, config, session)

        slot = grid.get(d.id, 1, Day.MONDAY, Period.AM)
        assert slot.assigned_room_id is None

    def test_requires_room_never_pre_occupies(self, session, monday):
        t = make_template(session, is_active=True)
        d = make_doctor(session, code="AA")
        room = make_room(session, code="D1")
        make_master_session(
            session, t, d, week=1, day=Day.MONDAY, period=Period.AM,
            session_type=MasterSessionType.REQUIRES_ROOM, room=room,
        )

        config = RotaConfig(start_date=monday, num_weeks=1, template_start_week=1)
        ctx = load_context(session, config)
        grid, counters = run_phase2(ctx, config, session)

        slot = grid.get(d.id, 1, Day.MONDAY, Period.AM)
        # template_room_id is retained for reference, but occupancy/assignment
        # is left for Phases 5/7-9A -- REQUIRES_ROOM never pre-occupies.
        assert slot.template_room_id == room.id
        assert slot.assigned_room_id is None
        assert grid.is_room_free(1, Day.MONDAY, Period.AM, room.id) is True

    def test_no_surgery_no_occupancy(self, session, monday):
        t = make_template(session, is_active=True)
        d = make_doctor(session, code="AA")
        make_master_session(
            session, t, d, week=1, day=Day.MONDAY, period=Period.AM,
            session_type=MasterSessionType.NO_SURGERY,
        )

        config = RotaConfig(start_date=monday, num_weeks=1, template_start_week=1)
        ctx = load_context(session, config)
        grid, counters = run_phase2(ctx, config, session)

        assert grid.get(d.id, 1, Day.MONDAY, Period.AM).assigned_room_id is None


class TestTemplateStartWeekRotation:
    def test_gen_week_maps_to_correct_template_week(self, session, monday):
        t = make_template(session, is_active=True)
        d = make_doctor(session, code="AA")
        room = make_room(session, code="D7")
        # template week 3 (used by gen_week 1 when start_week=3): NO_SURGERY
        make_master_session(
            session, t, d, week=3, day=Day.MONDAY, period=Period.AM,
            session_type=MasterSessionType.NO_SURGERY,
        )
        # template week 4 (used by gen_week 2 when start_week=3): ADMIN_TIME+room
        make_master_session(
            session, t, d, week=4, day=Day.MONDAY, period=Period.AM,
            session_type=MasterSessionType.ADMIN_TIME, room=room,
        )

        config = RotaConfig(start_date=monday, num_weeks=2, template_start_week=3)
        ctx = load_context(session, config)
        grid, counters = run_phase2(ctx, config, session)

        gen_week1_slot = grid.get(d.id, 1, Day.MONDAY, Period.AM)
        gen_week2_slot = grid.get(d.id, 2, Day.MONDAY, Period.AM)

        assert gen_week1_slot.template_type == MasterSessionType.NO_SURGERY
        assert gen_week1_slot.assigned_room_id is None
        assert gen_week2_slot.template_type == MasterSessionType.ADMIN_TIME
        assert gen_week2_slot.assigned_room_id == room.id


class TestCounterStateLoading:
    def test_clinic_and_system_counters_loaded(self, session, monday):
        t = make_template(session, is_active=True)
        d = make_doctor(session, code="AA")
        ct = make_clinic_type(session, name="Dragon")
        make_clinic_counter(session, d, ct, raw_count=3)
        make_system_counter(session, d, SystemCounterType.ROOM_MOVE, raw_count=2)
        make_system_counter(session, d, SystemCounterType.SUPERVISION, raw_count=0)

        config = RotaConfig(start_date=monday, num_weeks=1, template_start_week=1)
        ctx = load_context(session, config)
        grid, counters = run_phase2(ctx, config, session)

        assert counters.clinic[(d.id, ct.id)] == 3
        assert counters.system[(d.id, SystemCounterType.ROOM_MOVE)] == 2
        assert counters.system[(d.id, SystemCounterType.SUPERVISION)] == 0
        # Loaded counters are pre-existing, not "new" -- _write_to_db (step 9)
        # must UPDATE these, not INSERT.
        assert counters.is_new_clinic_key(d.id, ct.id) is False

    def test_no_counters_yields_empty_counter_state(self, session, monday):
        make_template(session, is_active=True)
        config = RotaConfig(start_date=monday, num_weeks=1, template_start_week=1)
        ctx = load_context(session, config)
        grid, counters = run_phase2(ctx, config, session)

        assert counters.clinic == {}
        assert counters.system == {}
