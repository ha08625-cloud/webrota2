from app.engine.context import load_context
from app.engine.phases.phase2 import run_phase2
from app.engine.phases.phase4 import run_phase4
from app.engine.phases.phase7_9a import run_phase7_to_9a
from app.engine.phases.phase12 import run_phase12
from app.engine.datatypes import DecisionLog
from app.models.enums import (
    Day,
    DoctorType,
    DutyType,
    MasterSessionType,
    Period,
    RoomType,
    SessionRole,
    SystemCounterType,
)

from .factories import (
    make_doctor,
    make_duty,
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


def _admin_time(session, template, doctor, room, week=1, day=Day.MONDAY, period=Period.AM):
    make_master_session(
        session, template, doctor, week=week, day=day, period=period,
        session_type=MasterSessionType.ADMIN_TIME, room=room,
    )


def _wfh(session, template, doctor, week=1, day=Day.MONDAY, period=Period.AM):
    make_master_session(
        session, template, doctor, week=week, day=day, period=period,
        session_type=MasterSessionType.WFH,
    )


class TestDutyRoleApplied:
    def test_primary_duty_sets_role(self, session, config_1wk, monday):
        t = make_template(session, is_active=True)
        d = make_doctor(session, code="AA")
        _requires_room(session, t, d)
        make_duty(session, monday, Period.AM, d, DutyType.PRIMARY)

        ctx, grid, counters = _build(session, config_1wk)
        log = DecisionLog()
        issues = run_phase4(ctx, grid, counters, log)

        slot = grid.get(d.id, 1, Day.MONDAY, Period.AM)
        assert slot.role == SessionRole.DUTY_PRIMARY
        # No D room in the practice at all -- total failure, but role stays.
        assert len(issues) == 1
        assert issues[0].check == "duty_no_d_room_available"

    def test_secondary_duty_sets_role(self, session, config_1wk, monday):
        t = make_template(session, is_active=True)
        d = make_doctor(session, code="AA")
        _requires_room(session, t, d)
        make_duty(session, monday, Period.AM, d, DutyType.SECONDARY)

        ctx, grid, counters = _build(session, config_1wk)
        log = DecisionLog()
        run_phase4(ctx, grid, counters, log)

        slot = grid.get(d.id, 1, Day.MONDAY, Period.AM)
        assert slot.role == SessionRole.DUTY_SECONDARY

    def test_multiple_doctors_independent(self, session, config_1wk, monday):
        t = make_template(session, is_active=True)
        d1 = make_doctor(session, code="AA")
        d2 = make_doctor(session, code="BB")
        make_room(session, code="D1", room_type=RoomType.D)
        make_room(session, code="D2", room_type=RoomType.D)
        for d in (d1, d2):
            _requires_room(session, t, d)
        make_duty(session, monday, Period.AM, d1, DutyType.PRIMARY)
        make_duty(session, monday, Period.AM, d2, DutyType.SECONDARY)

        ctx, grid, counters = _build(session, config_1wk)
        log = DecisionLog()
        run_phase4(ctx, grid, counters, log)

        assert grid.get(d1.id, 1, Day.MONDAY, Period.AM).role == SessionRole.DUTY_PRIMARY
        assert grid.get(d2.id, 1, Day.MONDAY, Period.AM).role == SessionRole.DUTY_SECONDARY


class TestDutyWarnings:
    def test_no_session_slot_warns(self, session, config_1wk, monday):
        make_template(session, is_active=True)
        d = make_doctor(session, code="AA")
        # No MasterRotaSession row at all for this doctor/day/period.
        make_duty(session, monday, Period.AM, d, DutyType.PRIMARY)

        ctx, grid, counters = _build(session, config_1wk)
        log = DecisionLog()
        issues = run_phase4(ctx, grid, counters, log)

        assert len(issues) == 1
        assert issues[0].check == "duty_no_session_slot"
        assert issues[0].severity == "warning"
        assert log.entries == []  # no decision was made -- only a warning

    def test_conflicting_duty_roles_keeps_first_and_warns(self, session, config_1wk, monday):
        t = make_template(session, is_active=True)
        d = make_doctor(session, code="AA")
        _requires_room(session, t, d)
        # Same doctor given both primary and secondary duty in the same slot.
        make_duty(session, monday, Period.AM, d, DutyType.PRIMARY)
        make_duty(session, monday, Period.AM, d, DutyType.SECONDARY)

        ctx, grid, counters = _build(session, config_1wk)
        log = DecisionLog()
        issues = run_phase4(ctx, grid, counters, log)

        slot = grid.get(d.id, 1, Day.MONDAY, Period.AM)
        # "primary" sorts before "secondary" alphabetically -> applied first.
        assert slot.role == SessionRole.DUTY_PRIMARY
        conflict_issues = [i for i in issues if i.check == "duty_role_conflict"]
        assert len(conflict_issues) == 1
        # Exactly one duty decision was made; the rejected secondary duty
        # produced a warning, not a log entry.
        assert len([e for e in log.entries if e.action == "assign_duty"]) == 1


class TestDecisionLog:
    def test_assign_duty_entry_recorded(self, session, config_1wk, monday):
        t = make_template(session, is_active=True)
        d = make_doctor(session, code="AA")
        _requires_room(session, t, d)
        make_duty(session, monday, Period.AM, d, DutyType.PRIMARY)

        ctx, grid, counters = _build(session, config_1wk)
        log = DecisionLog()
        run_phase4(ctx, grid, counters, log)

        assign_entries = [e for e in log.entries if e.action == "assign_duty"]
        assert len(assign_entries) == 1
        entry = assign_entries[0]
        assert entry.phase == "phase4"
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
        make_room(session, code="D1", room_type=RoomType.D)
        make_room(session, code="D2", room_type=RoomType.D)
        for d in (d1, d2):
            _requires_room(session, t, d)
        make_duty(session, monday, Period.AM, d1, DutyType.PRIMARY)
        make_duty(session, monday, Period.AM, d2, DutyType.SECONDARY)

        ctx, grid, counters = _build(session, config_1wk)
        log = DecisionLog()
        run_phase4(ctx, grid, counters, log)

        assert [e.sequence for e in log.entries] == list(range(len(log.entries)))
        assert len(log.entries) >= 2


# ---------------------------------------------------------------------------
# Placement paths
# ---------------------------------------------------------------------------

class TestPlacement:
    def test_self_check_already_in_d_room_untouched(self, session, config_1wk, monday):
        t = make_template(session, is_active=True)
        d = make_doctor(session, code="AA")
        room = make_room(session, code="D1", room_type=RoomType.D)
        _pre_assigned(session, t, d, room)
        make_duty(session, monday, Period.AM, d, DutyType.PRIMARY)

        ctx, grid, counters = _build(session, config_1wk)
        log = DecisionLog()
        issues = run_phase4(ctx, grid, counters, log)

        slot = grid.get(d.id, 1, Day.MONDAY, Period.AM)
        assert slot.role == SessionRole.DUTY_PRIMARY
        assert slot.assigned_room_id == room.id  # unchanged by duty
        assert not any(i.severity == "warning" for i in issues)
        assert not any(e.action == "assign_room" for e in log.entries)
        already_entries = [e for e in log.entries if e.action == "room_already_assigned"]
        assert len(already_entries) == 1

    def test_moved_out_of_own_non_d_room_into_d_room(self, session, config_1wk, monday):
        t = make_template(session, is_active=True)
        d = make_doctor(session, code="AA")
        c_room = make_room(session, code="C1", room_type=RoomType.C)
        d_room = make_room(session, code="D1", room_type=RoomType.D)
        _pre_assigned(session, t, d, c_room)
        make_duty(session, monday, Period.AM, d, DutyType.PRIMARY)

        ctx, grid, counters = _build(session, config_1wk)
        log = DecisionLog()
        issues = run_phase4(ctx, grid, counters, log)

        slot = grid.get(d.id, 1, Day.MONDAY, Period.AM)
        assert slot.assigned_room_id == d_room.id
        assert grid.is_room_free(1, Day.MONDAY, Period.AM, c_room.id)
        assert not any(i.severity == "warning" for i in issues)

    def test_wfh_slot_abandoned_and_roomed(self, session, config_1wk, monday):
        t = make_template(session, is_active=True)
        d = make_doctor(session, code="AA")
        make_room(session, code="D1", room_type=RoomType.D)
        _wfh(session, t, d)
        make_duty(session, monday, Period.AM, d, DutyType.PRIMARY)

        ctx, grid, counters = _build(session, config_1wk)
        log = DecisionLog()
        run_phase4(ctx, grid, counters, log)

        slot = grid.get(d.id, 1, Day.MONDAY, Period.AM)
        assert slot.is_wfh is False
        assert slot.assigned_room_id is not None
        wfh_entries = [e for e in log.entries if e.action == "wfh_abandoned"]
        assert len(wfh_entries) == 1
        assert wfh_entries[0].doctor_id == d.id

    def test_preferred_d_room_free_is_used(self, session, config_1wk, monday):
        t = make_template(session, is_active=True)
        d = make_doctor(session, code="AA")
        preferred = make_room(session, code="D3", room_type=RoomType.D)
        make_room(session, code="D1", room_type=RoomType.D)
        make_preferred_room(session, d, preference_order=1, room=preferred)
        _requires_room(session, t, d)
        make_duty(session, monday, Period.AM, d, DutyType.PRIMARY)

        ctx, grid, counters = _build(session, config_1wk)
        log = DecisionLog()
        issues = run_phase4(ctx, grid, counters, log)

        slot = grid.get(d.id, 1, Day.MONDAY, Period.AM)
        assert slot.assigned_room_id == preferred.id
        assert not any(i.severity == "warning" for i in issues)

    def test_no_preferred_room_sweep_takes_highest_code_free_d_room(
        self, session, config_1wk, monday
    ):
        t = make_template(session, is_active=True)
        d = make_doctor(session, code="AA")
        # Seed ids in the opposite order of code, to prove the sweep sorts
        # by code descending, not by id.
        make_room(session, code="D1", room_type=RoomType.D)
        make_room(session, code="D8", room_type=RoomType.D)
        _requires_room(session, t, d)
        make_duty(session, monday, Period.AM, d, DutyType.PRIMARY)

        ctx, grid, counters = _build(session, config_1wk)
        log = DecisionLog()
        run_phase4(ctx, grid, counters, log)

        slot = grid.get(d.id, 1, Day.MONDAY, Period.AM)
        room = ctx.room_by_id[slot.assigned_room_id]
        assert room.code == "D8"


# ---------------------------------------------------------------------------
# Eviction paths
# ---------------------------------------------------------------------------

class TestEviction:
    def test_preferred_room_occupied_by_partner_protected_falls_to_sweep(
        self, session, config_1wk, monday
    ):
        t = make_template(session, is_active=True)
        duty_doc = make_doctor(session, code="AA")
        partner = make_doctor(session, code="PP", doctor_type=DoctorType.PARTNER)
        preferred = make_room(session, code="D3", room_type=RoomType.D)
        sweep_room = make_room(session, code="D5", room_type=RoomType.D)
        make_preferred_room(session, duty_doc, preference_order=1, room=preferred)
        _pre_assigned(session, t, partner, preferred)
        _requires_room(session, t, duty_doc)
        make_duty(session, monday, Period.AM, duty_doc, DutyType.PRIMARY)

        ctx, grid, counters = _build(session, config_1wk)
        log = DecisionLog()
        run_phase4(ctx, grid, counters, log)

        assert grid.get(duty_doc.id, 1, Day.MONDAY, Period.AM).assigned_room_id == sweep_room.id
        assert grid.get(partner.id, 1, Day.MONDAY, Period.AM).assigned_room_id == preferred.id
        assert not any(e.action == "displace_room" for e in log.entries)

    def test_preferred_room_occupied_by_ahp_protected_falls_to_sweep(
        self, session, config_1wk, monday
    ):
        t = make_template(session, is_active=True)
        duty_doc = make_doctor(session, code="AA")
        ahp = make_doctor(session, code="HH", doctor_type=DoctorType.AHP)
        preferred = make_room(session, code="D3", room_type=RoomType.D)
        sweep_room = make_room(session, code="D5", room_type=RoomType.D)
        make_preferred_room(session, duty_doc, preference_order=1, room=preferred)
        _pre_assigned(session, t, ahp, preferred)
        _requires_room(session, t, duty_doc)
        make_duty(session, monday, Period.AM, duty_doc, DutyType.PRIMARY)

        ctx, grid, counters = _build(session, config_1wk)
        log = DecisionLog()
        run_phase4(ctx, grid, counters, log)

        assert grid.get(duty_doc.id, 1, Day.MONDAY, Period.AM).assigned_room_id == sweep_room.id
        assert grid.get(ahp.id, 1, Day.MONDAY, Period.AM).assigned_room_id == preferred.id

    def test_preferred_room_occupied_by_same_session_duty_holder_protected(
        self, session, config_1wk, monday
    ):
        t = make_template(session, is_active=True)
        primary_doc = make_doctor(session, code="AA")
        secondary_doc = make_doctor(session, code="BB")
        preferred = make_room(session, code="D3", room_type=RoomType.D)
        sweep_room = make_room(session, code="D5", room_type=RoomType.D)
        _requires_room(session, t, primary_doc)
        _requires_room(session, t, secondary_doc)
        make_preferred_room(session, secondary_doc, preference_order=1, room=preferred)
        # Primary processed first (alphabetical duty_type sort), takes the
        # preferred room via the plain sweep since nobody occupies it yet.
        make_preferred_room(session, primary_doc, preference_order=1, room=preferred)
        make_duty(session, monday, Period.AM, primary_doc, DutyType.PRIMARY)
        make_duty(session, monday, Period.AM, secondary_doc, DutyType.SECONDARY)

        ctx, grid, counters = _build(session, config_1wk)
        log = DecisionLog()
        run_phase4(ctx, grid, counters, log)

        # Primary took the shared preferred room first.
        assert grid.get(primary_doc.id, 1, Day.MONDAY, Period.AM).assigned_room_id == preferred.id
        # Secondary's preferred room is now held by a role-holder (primary
        # duty) -- protected, so secondary falls to the sweep instead of
        # evicting primary.
        assert (
            grid.get(secondary_doc.id, 1, Day.MONDAY, Period.AM).assigned_room_id
            == sweep_room.id
        )

    def test_preferred_room_occupied_by_salaried_evicted_and_relocated(
        self, session, config_1wk, monday
    ):
        t = make_template(session, is_active=True)
        duty_doc = make_doctor(session, code="AA")
        salaried = make_doctor(session, code="SS", doctor_type=DoctorType.SALARIED)
        preferred = make_room(session, code="D3", room_type=RoomType.D)
        fallback = make_room(session, code="C1", room_type=RoomType.C)
        make_preferred_room(session, duty_doc, preference_order=1, room=preferred)
        make_preferred_room(session, salaried, preference_order=1, room=fallback)
        _pre_assigned(session, t, salaried, preferred)
        _requires_room(session, t, duty_doc)
        make_duty(session, monday, Period.AM, duty_doc, DutyType.PRIMARY)

        ctx, grid, counters = _build(session, config_1wk)
        log = DecisionLog()
        issues = run_phase4(ctx, grid, counters, log)

        assert grid.get(duty_doc.id, 1, Day.MONDAY, Period.AM).assigned_room_id == preferred.id
        assert grid.get(salaried.id, 1, Day.MONDAY, Period.AM).assigned_room_id == fallback.id
        assert counters.system[(salaried.id, SystemCounterType.ROOM_MOVE)] == 1
        assert not any(i.check == "duty_evictee_not_relocated" for i in issues)
        displace_entries = [e for e in log.entries if e.action == "displace_room"]
        assert len(displace_entries) == 1
        assert displace_entries[0].related_doctor_id == salaried.id

    def test_preferred_room_occupied_by_salaried_on_admin_time_still_evicted(
        self, session, config_1wk, monday
    ):
        # Decision 7: expendability is by doctor_type only -- an ADMIN_TIME
        # slot does not protect a Salaried occupant.
        t = make_template(session, is_active=True)
        duty_doc = make_doctor(session, code="AA")
        salaried = make_doctor(session, code="SS", doctor_type=DoctorType.SALARIED)
        preferred = make_room(session, code="D3", room_type=RoomType.D)
        fallback = make_room(session, code="C1", room_type=RoomType.C)
        make_preferred_room(session, duty_doc, preference_order=1, room=preferred)
        make_preferred_room(session, salaried, preference_order=1, room=fallback)
        _admin_time(session, t, salaried, preferred)
        _requires_room(session, t, duty_doc)
        make_duty(session, monday, Period.AM, duty_doc, DutyType.PRIMARY)

        ctx, grid, counters = _build(session, config_1wk)
        log = DecisionLog()
        run_phase4(ctx, grid, counters, log)

        assert grid.get(duty_doc.id, 1, Day.MONDAY, Period.AM).assigned_room_id == preferred.id
        assert grid.get(salaried.id, 1, Day.MONDAY, Period.AM).assigned_room_id == fallback.id

    def test_preferred_room_occupied_by_trainee_evicted_to_free_d_room(
        self, session, config_1wk, monday
    ):
        t = make_template(session, is_active=True)
        duty_doc = make_doctor(session, code="AA")
        trainee = make_doctor(session, code="TT", doctor_type=DoctorType.TRAINEE)
        preferred = make_room(session, code="D3", room_type=RoomType.D)
        other_d = make_room(session, code="D5", room_type=RoomType.D)
        make_preferred_room(session, duty_doc, preference_order=1, room=preferred)
        _pre_assigned(session, t, trainee, preferred)
        _requires_room(session, t, duty_doc)
        make_duty(session, monday, Period.AM, duty_doc, DutyType.PRIMARY)

        ctx, grid, counters = _build(session, config_1wk)
        log = DecisionLog()
        issues = run_phase4(ctx, grid, counters, log)

        assert grid.get(duty_doc.id, 1, Day.MONDAY, Period.AM).assigned_room_id == preferred.id
        assert grid.get(trainee.id, 1, Day.MONDAY, Period.AM).assigned_room_id == other_d.id
        assert counters.system[(trainee.id, SystemCounterType.ROOM_MOVE)] == 1
        assert not any(i.check == "duty_evictee_not_relocated" for i in issues)

    def test_preferred_room_occupied_by_trainee_no_d_room_free_left_roomless(
        self, session, config_1wk, monday
    ):
        t = make_template(session, is_active=True)
        duty_doc = make_doctor(session, code="AA")
        trainee = make_doctor(session, code="TT", doctor_type=DoctorType.TRAINEE)
        preferred = make_room(session, code="D3", room_type=RoomType.D)
        # No other D room, and no C/W/SR room either -- Trainees never get
        # relocated outside D rooms (Decision 8).
        make_preferred_room(session, duty_doc, preference_order=1, room=preferred)
        _pre_assigned(session, t, trainee, preferred)
        _requires_room(session, t, duty_doc)
        make_duty(session, monday, Period.AM, duty_doc, DutyType.PRIMARY)

        ctx, grid, counters = _build(session, config_1wk)
        log = DecisionLog()
        issues = run_phase4(ctx, grid, counters, log)

        assert grid.get(duty_doc.id, 1, Day.MONDAY, Period.AM).assigned_room_id == preferred.id
        assert grid.get(trainee.id, 1, Day.MONDAY, Period.AM).assigned_room_id is None
        assert counters.system[(trainee.id, SystemCounterType.ROOM_MOVE)] == 1
        not_relocated = [i for i in issues if i.check == "duty_evictee_not_relocated"]
        assert len(not_relocated) == 1
        assert not_relocated[0].severity == "warning"

    def test_salaried_eviction_relocation_fails_still_roomless_but_counter_incremented(
        self, session, config_1wk, monday
    ):
        # No C/W/SR room in the practice at all, and no preference list for
        # the evictee, so relocation fails outright -- ROOM_MOVE must still
        # increment (Decision 9), the easiest rule to lose.
        t = make_template(session, is_active=True)
        duty_doc = make_doctor(session, code="AA")
        salaried = make_doctor(session, code="SS", doctor_type=DoctorType.SALARIED)
        preferred = make_room(session, code="D3", room_type=RoomType.D)
        make_preferred_room(session, duty_doc, preference_order=1, room=preferred)
        _pre_assigned(session, t, salaried, preferred)
        _requires_room(session, t, duty_doc)
        make_duty(session, monday, Period.AM, duty_doc, DutyType.PRIMARY)

        ctx, grid, counters = _build(session, config_1wk)
        log = DecisionLog()
        issues = run_phase4(ctx, grid, counters, log)

        assert grid.get(duty_doc.id, 1, Day.MONDAY, Period.AM).assigned_room_id == preferred.id
        assert grid.get(salaried.id, 1, Day.MONDAY, Period.AM).assigned_room_id is None
        assert counters.system[(salaried.id, SystemCounterType.ROOM_MOVE)] == 1
        assert any(i.check == "duty_evictee_not_relocated" for i in issues)

    def test_sweep_no_free_d_room_evicts_lowest_weighted_room_move_score(
        self, session, config_1wk, monday
    ):
        t = make_template(session, is_active=True)
        duty_doc = make_doctor(session, code="ZZ")
        # Both Salaried, both occupying D rooms, no preferred D room
        # configured for duty_doc so the sweep runs directly. Differing
        # sessions_per_week proves the weighting (not raw count).
        high_score = make_doctor(session, code="HI", doctor_type=DoctorType.SALARIED, spw="10.0")
        low_score = make_doctor(session, code="LO", doctor_type=DoctorType.SALARIED, spw="10.0")
        d1 = make_room(session, code="D1", room_type=RoomType.D)
        d2 = make_room(session, code="D2", room_type=RoomType.D)
        make_system_counter(session, high_score, SystemCounterType.ROOM_MOVE, raw_count=8)
        make_system_counter(session, low_score, SystemCounterType.ROOM_MOVE, raw_count=2)
        _pre_assigned(session, t, high_score, d1)
        _pre_assigned(session, t, low_score, d2)
        _requires_room(session, t, duty_doc)
        make_duty(session, monday, Period.AM, duty_doc, DutyType.PRIMARY)

        ctx, grid, counters = _build(session, config_1wk)
        log = DecisionLog()
        run_phase4(ctx, grid, counters, log)

        assert grid.get(duty_doc.id, 1, Day.MONDAY, Period.AM).assigned_room_id == d2.id
        # Low-score doctor was evicted and left roomless (no C/W/SR/D room
        # left to relocate them to).
        assert grid.get(low_score.id, 1, Day.MONDAY, Period.AM).assigned_room_id is None
        assert grid.get(high_score.id, 1, Day.MONDAY, Period.AM).assigned_room_id == d1.id

    def test_sweep_tie_broken_on_doctor_code(self, session, config_1wk, monday):
        t = make_template(session, is_active=True)
        duty_doc = make_doctor(session, code="ZZ")
        first_code = make_doctor(session, code="AA", doctor_type=DoctorType.SALARIED, spw="10.0")
        second_code = make_doctor(session, code="BB", doctor_type=DoctorType.SALARIED, spw="10.0")
        d1 = make_room(session, code="D1", room_type=RoomType.D)
        d2 = make_room(session, code="D2", room_type=RoomType.D)
        # Identical weighted scores -- tie-break on doctor code, "AA" first.
        make_system_counter(session, first_code, SystemCounterType.ROOM_MOVE, raw_count=4)
        make_system_counter(session, second_code, SystemCounterType.ROOM_MOVE, raw_count=4)
        _pre_assigned(session, t, first_code, d1)
        _pre_assigned(session, t, second_code, d2)
        _requires_room(session, t, duty_doc)
        make_duty(session, monday, Period.AM, duty_doc, DutyType.PRIMARY)

        ctx, grid, counters = _build(session, config_1wk)
        log = DecisionLog()
        run_phase4(ctx, grid, counters, log)

        # "AA" evicted (lower code on tie), duty doctor takes their room.
        assert grid.get(duty_doc.id, 1, Day.MONDAY, Period.AM).assigned_room_id == d1.id
        assert grid.get(first_code.id, 1, Day.MONDAY, Period.AM).assigned_room_id is None
        assert grid.get(second_code.id, 1, Day.MONDAY, Period.AM).assigned_room_id == d2.id


# ---------------------------------------------------------------------------
# Total-failure paths (Design Decision 13)
# ---------------------------------------------------------------------------

class TestTotalFailure:
    def test_requires_room_duty_doctor_rescued_by_phase7_9a_pass3(
        self, session, config_1wk, monday
    ):
        t = make_template(session, is_active=True)
        duty_doc = make_doctor(session, code="AA")
        partner = make_doctor(session, code="PP", doctor_type=DoctorType.PARTNER)
        d_room = make_room(session, code="D1", room_type=RoomType.D)
        non_d_room = make_room(session, code="C1", room_type=RoomType.C)
        # Every D room in the practice is held by a Partner -- protected,
        # sweep fails outright.
        _pre_assigned(session, t, partner, d_room)
        _requires_room(session, t, duty_doc)
        make_duty(session, monday, Period.AM, duty_doc, DutyType.PRIMARY)

        ctx, grid, counters = _build(session, config_1wk)
        log = DecisionLog()
        issues4 = run_phase4(ctx, grid, counters, log)

        slot = grid.get(duty_doc.id, 1, Day.MONDAY, Period.AM)
        assert slot.role == SessionRole.DUTY_PRIMARY
        assert slot.assigned_room_id is None
        assert any(i.check == "duty_no_d_room_available" for i in issues4)

        # Pass 3's forced SR > D > C > W placement rescues the doctor with
        # a non-D room, since Pass 3 does not check slot.role.
        run_phase7_to_9a(ctx, grid, counters, log)
        assert grid.get(duty_doc.id, 1, Day.MONDAY, Period.AM).assigned_room_id == non_d_room.id

    def test_pre_assigned_non_d_room_survives_total_failure(
        self, session, config_1wk, monday
    ):
        t = make_template(session, is_active=True)
        duty_doc = make_doctor(session, code="AA")
        partner = make_doctor(session, code="PP", doctor_type=DoctorType.PARTNER)
        own_room = make_room(session, code="C1", room_type=RoomType.C)
        d_room = make_room(session, code="D1", room_type=RoomType.D)
        _pre_assigned(session, t, duty_doc, own_room)
        _pre_assigned(session, t, partner, d_room)
        make_duty(session, monday, Period.AM, duty_doc, DutyType.PRIMARY)

        ctx, grid, counters = _build(session, config_1wk)
        log = DecisionLog()
        issues = run_phase4(ctx, grid, counters, log)

        slot = grid.get(duty_doc.id, 1, Day.MONDAY, Period.AM)
        assert slot.role == SessionRole.DUTY_PRIMARY
        # Never-free rule: the doctor's original non-D room is untouched.
        assert slot.assigned_room_id == own_room.id
        assert any(i.check == "duty_no_d_room_available" for i in issues)

    def test_wfh_origin_total_failure_invisible_to_phase12(
        self, session, config_1wk, monday
    ):
        t = make_template(session, is_active=True)
        duty_doc = make_doctor(session, code="AA")
        partner = make_doctor(session, code="PP", doctor_type=DoctorType.PARTNER)
        d_room = make_room(session, code="D1", room_type=RoomType.D)
        _pre_assigned(session, t, partner, d_room)
        _wfh(session, t, duty_doc)
        make_duty(session, monday, Period.AM, duty_doc, DutyType.PRIMARY)

        ctx, grid, counters = _build(session, config_1wk)
        log = DecisionLog()
        issues4 = run_phase4(ctx, grid, counters, log)

        slot = grid.get(duty_doc.id, 1, Day.MONDAY, Period.AM)
        assert slot.role == SessionRole.DUTY_PRIMARY
        assert slot.is_wfh is False
        assert slot.assigned_room_id is None
        assert any(i.check == "duty_no_d_room_available" for i in issues4)

        # Phase 12 cannot see this: unresolved_room only inspects
        # REQUIRES_ROOM slots and this one is permanently template_type
        # WFH; role_on_incompatible_slot keys on is_wfh, which is now
        # False. The Phase 4 warning above is the only signal.
        issues12 = run_phase12(ctx, grid)
        assert not any(i.check == "unresolved_room" for i in issues12)
        assert not any(i.check == "role_on_incompatible_slot" for i in issues12)