import datetime

from app.engine.context import load_context
from app.models.enums import Day, DoctorType, DutyType, MasterSessionType, Period, RoomType

from .factories import (
    make_clinic_type,
    make_doctor,
    make_duty,
    make_leave,
    make_master_session,
    make_room,
    make_template,
)


class TestDoctors:
    def test_active_only_and_sorted_by_code(self, session, config_1wk):
        make_doctor(session, code="BB")
        make_doctor(session, code="AA")
        make_doctor(session, code="ZZ", active=False)

        ctx = load_context(session, config_1wk)

        assert [d.code for d in ctx.doctors] == ["AA", "BB"]

    def test_doctor_by_id_and_spw_include_inactive(self, session, config_1wk):
        inactive = make_doctor(session, code="ZZ", active=False, spw="6.0")

        ctx = load_context(session, config_1wk)

        assert ctx.doctor_by_id[inactive.id] is inactive
        assert ctx.spw_by_id[inactive.id] == 6.0
        assert inactive not in ctx.doctors


class TestRooms:
    def test_rooms_by_type_grouping(self, session, config_1wk):
        d1 = make_room(session, code="D1", room_type=RoomType.D)
        d2 = make_room(session, code="D2", room_type=RoomType.D)
        c1 = make_room(session, code="C1", room_type=RoomType.C)

        ctx = load_context(session, config_1wk)

        d_ids = {r.id for r in ctx.rooms_by_type[RoomType.D]}
        assert d_ids == {d1.id, d2.id}
        assert ctx.rooms_by_type[RoomType.C] == (c1,)
        assert ctx.room_by_id[d1.id] is d1


class TestClinicTypes:
    def test_enabled_only_ordered_by_priority(self, session, config_1wk):
        low_priority_first = make_clinic_type(session, name="A", clinic_priority=20)
        high_priority = make_clinic_type(session, name="B", clinic_priority=10)
        make_clinic_type(session, name="Disabled", clinic_priority=5, is_enabled=False)

        ctx = load_context(session, config_1wk)

        assert [c.name for c in ctx.clinic_types] == ["B", "A"]
        assert len(ctx.clinic_types) == 2

    def test_schedules_and_doctor_eligibilities_loaded(self, session, config_1wk):
        d = make_doctor(session, code="AA")
        ct = make_clinic_type(
            session, name="Dragon",
            schedules=[(Day.MONDAY, Period.AM), (Day.WEDNESDAY, Period.AM)],
            doctor_eligibilities=[(d.id, 1)],
        )

        ctx = load_context(session, config_1wk)
        info = ctx.clinic_types[0]

        assert set((s.day, s.period) for s in info.schedules) == {
            (Day.MONDAY, Period.AM), (Day.WEDNESDAY, Period.AM),
        }
        assert info.doctor_eligibilities[0].doctor_id == d.id
        assert info.doctor_eligibilities[0].doctor_priority == 1

    def test_room_eligibility_expands_room_type_to_concrete_ids(self, session, config_1wk):
        d1 = make_room(session, code="D1", room_type=RoomType.D)
        d2 = make_room(session, code="D2", room_type=RoomType.D)
        make_room(session, code="C1", room_type=RoomType.C)
        make_clinic_type(session, name="Dragon", room_required=True, room_types=[RoomType.D])

        ctx = load_context(session, config_1wk)
        info = ctx.clinic_types[0]

        assert set(info.eligible_room_ids) == {d1.id, d2.id}

    def test_room_eligibility_specific_room_id(self, session, config_1wk):
        d1 = make_room(session, code="D1", room_type=RoomType.D)
        make_clinic_type(session, name="Dragon", room_required=True, room_ids=[d1.id])

        ctx = load_context(session, config_1wk)
        info = ctx.clinic_types[0]

        assert info.eligible_room_ids == (d1.id,)


class TestLeaveAndDutyDateRange:
    def test_leave_filtered_to_run_range(self, session, config_1wk, monday):
        d = make_doctor(session, code="AA")
        before = monday - datetime.timedelta(days=1)
        in_range = monday
        after = monday + datetime.timedelta(days=7)  # exclusive end for 1wk run

        make_leave(session, d, before, Period.AM)
        make_leave(session, d, in_range, Period.AM)
        make_leave(session, d, after, Period.AM)

        ctx = load_context(session, config_1wk)

        assert (d.id, in_range, Period.AM) in ctx.leave_set
        assert (d.id, before, Period.AM) not in ctx.leave_set
        assert (d.id, after, Period.AM) not in ctx.leave_set
        assert len(ctx.leave_set) == 1

    def test_duty_filtered_to_run_range(self, session, config_1wk, monday):
        d = make_doctor(session, code="AA")
        after = monday + datetime.timedelta(days=7)

        make_duty(session, monday, Period.AM, d, DutyType.PRIMARY)
        make_duty(session, after, Period.AM, d, DutyType.PRIMARY)

        ctx = load_context(session, config_1wk)

        assert ctx.duty_map[(monday, Period.AM, DutyType.PRIMARY)] == d.id
        assert (after, Period.AM, DutyType.PRIMARY) not in ctx.duty_map
        assert len(ctx.duty_map) == 1


class TestWeekDates:
    def test_week_dates_match_config(self, session, config_2wk, monday):
        ctx = load_context(session, config_2wk)

        assert ctx.week_dates[(1, Day.MONDAY)] == monday
        assert ctx.week_dates[(2, Day.FRIDAY)] == monday + datetime.timedelta(days=11)
        assert ctx.date_to_genslot[monday] == (1, Day.MONDAY)


class TestActiveTemplate:
    def test_single_active_template_loaded_with_sessions(self, session, config_1wk):
        d = make_doctor(session, code="AA")
        room = make_room(session, code="D1")
        t = make_template(session, is_active=True)
        make_master_session(
            session, t, d, week=1, day=Day.MONDAY, period=Period.AM,
            session_type=MasterSessionType.PRE_ASSIGNED, room=room,
        )

        ctx = load_context(session, config_1wk)

        assert ctx.active_template is t
        key = (d.id, 1, Day.MONDAY, Period.AM)
        assert ctx.template_sessions[key] == (MasterSessionType.PRE_ASSIGNED, room.id)

    def test_zero_active_templates_returns_none(self, session, config_1wk):
        make_template(session, is_active=False)

        ctx = load_context(session, config_1wk)

        assert ctx.active_template is None
        assert ctx.template_sessions == {}

    def test_multiple_active_templates_returns_none(self, session, config_1wk):
        make_template(session, name="One", is_active=True)
        make_template(session, name="Two", is_active=True)

        ctx = load_context(session, config_1wk)

        assert ctx.active_template is None
        assert ctx.template_sessions == {}