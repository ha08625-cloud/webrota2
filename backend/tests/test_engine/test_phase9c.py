from decimal import Decimal

from app.engine.context import load_context
from app.engine.phases.phase2 import run_phase2
from app.engine.phases.phase9c import reserved_sr_room_ids, run_phase9c
from app.engine.datatypes import DecisionLog
from app.models.enums import (
    Day,
    DoctorType,
    MasterSessionType,
    Period,
    RoomType,
    PreferenceWeight,
    SessionRole,
    SystemCounterType,
)

from .factories import (
    make_doctor,
    make_leave,
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


class TestSrBooking:
    """Phase 9C seats the chosen supervisor in an SR room.

    Nothing is swapped: the phase runs before the room passes now, so SR is
    normally still free and the supervisor simply takes it. The booking is a
    no-op in exactly two cases -- the supervisor already sits in SR, or a
    PRE_ASSIGNED template row has claimed the only SR room (D7 in the
    supervision phase-order plan). In neither case is an occupant displaced
    to make space.
    """

    def test_only_candidate_already_in_sr_no_booking_entry(self, session, config_1wk):
        # Sole eligible doctor happens to sit in SR -- selected via the
        # normal pool path (there is only one candidate), and the booking
        # step is a no-op because they are already where it would put them.
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

        assert not any(e.action == "book_sr_room" for e in log.entries)

    def test_sr_unoccupied_is_booked_for_the_supervisor(self, session, config_1wk):
        # The ordinary case at 9C's position in the pipeline: an SR room
        # exists and nothing holds it, so the supervisor is seated there and
        # the D room they came out of is released.
        t = make_template(session, is_active=True)
        trainee = make_doctor(session, code="TT", doctor_type=DoctorType.TRAINEE)
        supervisor = make_doctor(session, code="PP", doctor_type=DoctorType.PARTNER)
        d_room = make_room(session, code="D1", room_type=RoomType.D)
        sr_room = make_room(session, code="SR1", room_type=RoomType.SR)

        _requires_room(session, t, trainee)
        _pre_assigned(session, t, supervisor, d_room)

        ctx, grid, counters = _build(session, config_1wk)
        log = DecisionLog()
        run_phase9c(ctx, grid, counters, log)

        slot = grid.get(supervisor.id, 1, Day.MONDAY, Period.AM)
        assert slot.is_supervising is True
        assert slot.assigned_room_id == sr_room.id
        assert grid.is_room_free(1, Day.MONDAY, Period.AM, d_room.id)

        book_entries = [e for e in log.entries if e.action == "book_sr_room"]
        assert len(book_entries) == 1
        assert book_entries[0].doctor_id == supervisor.id
        assert book_entries[0].room_id == sr_room.id
        assert book_entries[0].related_room_id == d_room.id

        # assign_supervisor is written before the booking, so it still names
        # the room the supervisor was holding at selection time.
        assign = next(e for e in log.entries if e.action == "assign_supervisor")
        assert assign.room_id == d_room.id

    def test_roomless_supervisor_is_seated_in_sr(self, session, config_1wk):
        # The common shape of the pool at 9C's position: the candidate has a
        # REQUIRES_ROOM template row and no room at all yet, because Pass 3
        # of Phases 7-9A has not run. The booking is what rooms them.
        t = make_template(session, is_active=True)
        trainee = make_doctor(session, code="TT", doctor_type=DoctorType.TRAINEE)
        supervisor = make_doctor(session, code="PP", doctor_type=DoctorType.PARTNER)
        make_room(session, code="D1", room_type=RoomType.D)
        sr_room = make_room(session, code="SR1", room_type=RoomType.SR)

        _requires_room(session, t, trainee)
        _requires_room(session, t, supervisor)

        ctx, grid, counters = _build(session, config_1wk)
        slot = grid.get(supervisor.id, 1, Day.MONDAY, Period.AM)
        assert slot.assigned_room_id is None  # nothing has roomed them yet

        log = DecisionLog()
        run_phase9c(ctx, grid, counters, log)

        assert slot.is_supervising is True
        assert slot.assigned_room_id == sr_room.id

        book = next(e for e in log.entries if e.action == "book_sr_room")
        assert book.related_room_id is None
        assert "had no room yet" in book.rationale

    def test_pre_assigned_c_room_supervisor_is_moved_into_sr(self, session, config_1wk):
        # D3: a PRE_ASSIGNED C or W room is overridden, deliberately -- it is
        # the one template pin this phase breaks. The old room is freed, the
        # log says the pin was overridden, and no ROOM_MOVE counter moves:
        # the doctor is being seated for the job they were just given, not
        # displaced for someone else's.
        t = make_template(session, is_active=True)
        trainee = make_doctor(session, code="TT", doctor_type=DoctorType.TRAINEE)
        supervisor = make_doctor(session, code="PP", doctor_type=DoctorType.PARTNER)
        c_room = make_room(session, code="C1", room_type=RoomType.C)
        sr_room = make_room(session, code="SR1", room_type=RoomType.SR)

        _requires_room(session, t, trainee)
        _pre_assigned(session, t, supervisor, c_room)

        ctx, grid, counters = _build(session, config_1wk)
        log = DecisionLog()
        run_phase9c(ctx, grid, counters, log)

        slot = grid.get(supervisor.id, 1, Day.MONDAY, Period.AM)
        assert slot.assigned_room_id == sr_room.id
        assert grid.is_room_free(1, Day.MONDAY, Period.AM, c_room.id)
        assert counters.system.get((supervisor.id, SystemCounterType.ROOM_MOVE), 0) == 0

        book = next(e for e in log.entries if e.action == "book_sr_room")
        assert book.related_room_id == c_room.id
        assert "overrides the doctor's PRE_ASSIGNED template room" in book.rationale
        assert "changes no counter, ROOM_MOVE included" in book.rationale

    def test_first_sr_room_by_code_is_taken(self, session, config_1wk):
        # Two SR rooms, created so that id order and code order disagree.
        # The booking is by code, so it does not depend on insertion order.
        t = make_template(session, is_active=True)
        trainee = make_doctor(session, code="TT", doctor_type=DoctorType.TRAINEE)
        supervisor = make_doctor(session, code="PP", doctor_type=DoctorType.PARTNER)
        sr_late = make_room(session, code="SR2", room_type=RoomType.SR)
        sr_first = make_room(session, code="SR1", room_type=RoomType.SR)
        assert sr_late.id < sr_first.id

        _requires_room(session, t, trainee)
        _requires_room(session, t, supervisor)

        ctx, grid, counters = _build(session, config_1wk)
        log = DecisionLog()
        run_phase9c(ctx, grid, counters, log)

        slot = grid.get(supervisor.id, 1, Day.MONDAY, Period.AM)
        assert slot.assigned_room_id == sr_first.id

    def test_pre_assigned_trainee_holds_sr_no_booking(self, session, config_1wk):
        # D7's hole. A PRE_ASSIGNED template row claims the only SR room in
        # Phase 2, before any reservation can apply, so 9C finds none free:
        # the supervisor keeps the room they had, the occupant is left alone,
        # and Phase 12 flags the result. Phase 0 warns on the template row
        # itself -- see test_phase0.py.
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
        assert assign_entries[0].room_id == d_room.id

        assert grid.get(pool_doctor.id, 1, Day.MONDAY, Period.AM).assigned_room_id == d_room.id
        assert grid.get(sr_occupant.id, 1, Day.MONDAY, Period.AM).assigned_room_id == sr_room.id
        assert not any(e.action == "book_sr_room" for e in log.entries)

    def test_pool_winner_keeps_their_room_when_sr_is_taken(self, session, config_1wk):
        # Plain two-candidate pool win (lower raw SUPERVISION count). The SR
        # room is held by the loser's PRE_ASSIGNED row, so there is nothing
        # to book -- and, unlike the swap this replaced, the loser is not
        # turned out of it.
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
        assert grid.get(winner.id, 1, Day.MONDAY, Period.AM).assigned_room_id == d_room.id
        assert grid.get(sr_occupant.id, 1, Day.MONDAY, Period.AM).assigned_room_id == sr_room.id
        assert not any(e.action == "book_sr_room" for e in log.entries)

    def test_none_preference_sr_occupant_no_longer_auto_assigned(self, session, config_1wk):
        # There is no SR-priority fast path, so a "none"-preference doctor
        # sitting in SR gets no special treatment: the preference multiplier
        # still deprioritises them against a lower-scoring candidate, who
        # wins the pool outright. SR is taken by a PRE_ASSIGNED row, so the
        # winner is not booked into it and the occupant is not displaced.
        t = make_template(session, is_active=True)
        trainee = make_doctor(session, code="TT", doctor_type=DoctorType.TRAINEE)
        sr_occupant = make_doctor(
            session, code="PP", doctor_type=DoctorType.PARTNER,
            supervision_preference=PreferenceWeight.NONE,
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

        assert grid.get(pool_doctor.id, 1, Day.MONDAY, Period.AM).assigned_room_id == d_room.id
        assert grid.get(sr_occupant.id, 1, Day.MONDAY, Period.AM).assigned_room_id == sr_room.id
        assert grid.get(sr_occupant.id, 1, Day.MONDAY, Period.AM).is_supervising is False


class TestReservedSrRoomIds:
    """The per-session SR reservation Phases 4 and 5 consult (D6)."""

    def test_only_sessions_with_supervisable_trainees_are_reserved(
        self, session, config_1wk
    ):
        t = make_template(session, is_active=True)
        trainee = make_doctor(session, code="TT", doctor_type=DoctorType.TRAINEE)
        sr_room = make_room(session, code="SR1", room_type=RoomType.SR)

        # Monday AM has a trainee; Monday PM does not.
        _requires_room(session, t, trainee, period=Period.AM)

        ctx, grid, _counters = _build(session, config_1wk)
        reserved = reserved_sr_room_ids(ctx, grid)

        assert reserved[(1, Day.MONDAY, Period.AM)] == sr_room.id
        assert (1, Day.MONDAY, Period.PM) not in reserved
        assert (1, Day.TUESDAY, Period.AM) not in reserved

    def test_reserves_the_first_sr_room_by_code(self, session, config_1wk):
        # The same room `_book_sr_room` takes, chosen the same way, so the
        # reservation and the booking cannot pick different rooms.
        t = make_template(session, is_active=True)
        trainee = make_doctor(session, code="TT", doctor_type=DoctorType.TRAINEE)
        sr_late = make_room(session, code="SR2", room_type=RoomType.SR)
        sr_first = make_room(session, code="SR1", room_type=RoomType.SR)
        assert sr_late.id < sr_first.id

        _requires_room(session, t, trainee)

        ctx, grid, _counters = _build(session, config_1wk)
        assert reserved_sr_room_ids(ctx, grid)[(1, Day.MONDAY, Period.AM)] == sr_first.id

    def test_no_sr_room_in_the_practice_reserves_nothing(self, session, config_1wk):
        t = make_template(session, is_active=True)
        trainee = make_doctor(session, code="TT", doctor_type=DoctorType.TRAINEE)
        make_room(session, code="D1", room_type=RoomType.D)

        _requires_room(session, t, trainee)

        ctx, grid, _counters = _build(session, config_1wk)
        assert reserved_sr_room_ids(ctx, grid) == {}


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
            supervision_preference=PreferenceWeight.LESS,
        )
        raw_higher = make_doctor(
            session, code="AA", doctor_type=DoctorType.PARTNER, spw="10.0",
            supervision_preference=PreferenceWeight.MORE,
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
            supervision_preference=PreferenceWeight.NONE,
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
            supervision_preference=PreferenceWeight.NORMAL,
        )
        high_score = make_doctor(
            session, code="AA", doctor_type=DoctorType.PARTNER, spw="10.0",
            supervision_preference=PreferenceWeight.NORMAL,
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
    def test_no_eligible_supervisor_warns_and_logs_the_empty_pool(self, session, config_1wk):
        t = make_template(session, is_active=True)
        trainee = make_doctor(session, code="TT", doctor_type=DoctorType.TRAINEE)
        _requires_room(session, t, trainee)
        # No Partner/Salaried doctor exists at all.

        ctx, grid, counters = _build(session, config_1wk)
        log = DecisionLog()
        issues = run_phase9c(ctx, grid, counters, log)

        assert any(i.check == "supervision_unassignable" for i in issues)
        # The unsupervised session is logged as well as warned: with no
        # Partner/Salaried doctor in the session at all, both the pool and
        # the ruled-out list are empty, and the rationale says so rather
        # than leaving the reader to infer it from silence.
        entry = next(e for e in log.entries if e.action == "supervision_unassignable")
        assert "1 trainee(s) in this session need supervision." in entry.rationale
        assert "why each was ruled out: none" in entry.rationale


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

class TestDecisionLogRationale:
    """The supervision pool's `rationale`: who was in it, who was kept out,
    each doctor's raw count, sessions-per-week and preference multiplier,
    and the stage that decided."""

    def test_pool_line_shows_the_opening_balance_before_the_multiplier(
        self, session, config_1wk
    ):
        # The supervision line reports the unweighted score, then applies
        # the preference multiplier to it. The balance belongs to the first
        # of those, so the line's own arithmetic stays followable end to end.
        t = make_template(session, is_active=True)
        trainee = make_doctor(session, code="TT", doctor_type=DoctorType.TRAINEE)
        joiner = make_doctor(
            session, code="AA", doctor_type=DoctorType.PARTNER, spw="10.0",
            supervision_preference=PreferenceWeight.NORMAL,
        )
        peer = make_doctor(
            session, code="BB", doctor_type=DoctorType.PARTNER, spw="10.0",
            supervision_preference=PreferenceWeight.NORMAL,
        )
        _requires_room(session, t, trainee)
        _pre_assigned(session, t, joiner, make_room(session, code="D1", room_type=RoomType.D))
        _pre_assigned(session, t, peer, make_room(session, code="D2", room_type=RoomType.D))
        make_system_counter(
            session, joiner, SystemCounterType.SUPERVISION, raw_count=2,
            opening_balance=Decimal("4.0"),
        )
        make_system_counter(session, peer, SystemCounterType.SUPERVISION, raw_count=2)

        ctx, grid, counters = _build(session, config_1wk)
        log = DecisionLog()
        run_phase9c(ctx, grid, counters, log)

        entry = next(e for e in log.entries if e.action == "assign_supervisor")
        assert (
            "AA: raw 2 (+4 opening balance) / 10 sessions per week = 0.600, "
            "supervision preference normal (x1) -> 0.600" in entry.rationale
        )
        assert (
            "BB: raw 2 / 10 sessions per week = 0.200, supervision preference "
            "normal (x1) -> 0.200" in entry.rationale
        )
        # The credited doctor is not the one picked, which is the point.
        assert entry.doctor_id == peer.id

    def test_pool_lines_show_the_counter_and_the_preference_multiplier(
        self, session, config_1wk
    ):
        t = make_template(session, is_active=True)
        trainee = make_doctor(session, code="TT", doctor_type=DoctorType.TRAINEE)
        keen = make_doctor(
            session, code="AA", doctor_type=DoctorType.PARTNER, spw="10.0",
            supervision_preference=PreferenceWeight.MORE,
        )
        reluctant = make_doctor(
            session, code="BB", doctor_type=DoctorType.PARTNER, spw="10.0",
            supervision_preference=PreferenceWeight.LESS,
        )
        _requires_room(session, t, trainee)
        _pre_assigned(session, t, keen, make_room(session, code="D1", room_type=RoomType.D))
        _pre_assigned(session, t, reluctant, make_room(session, code="D2", room_type=RoomType.D))
        make_system_counter(session, keen, SystemCounterType.SUPERVISION, raw_count=4)
        make_system_counter(session, reluctant, SystemCounterType.SUPERVISION, raw_count=2)

        ctx, grid, counters = _build(session, config_1wk)
        log = DecisionLog()
        run_phase9c(ctx, grid, counters, log)

        entry = next(e for e in log.entries if e.action == "assign_supervisor")
        assert "1 trainee(s) in this session need supervision." in entry.rationale
        assert (
            "AA: raw 4 / 10 sessions per week = 0.400, supervision preference "
            "more (x0.66) -> 0.264" in entry.rationale
        )
        assert (
            "BB: raw 2 / 10 sessions per week = 0.200, supervision preference "
            "less (x1.5) -> 0.300" in entry.rationale
        )
        # AA wins on the preference-adjusted score despite the higher raw
        # count, and the rationale has to say that outright.
        assert entry.doctor_id == keen.id
        assert "the supervision-preference multipliers flipped this" in entry.rationale

    def test_scores_are_those_used_to_choose_not_post_assignment(self, session, config_1wk):
        """The winner's counter is incremented as part of the assignment. If
        the rationale were built afterwards it would show the incremented
        score -- which, on a tie decided alphabetically, reads as though the
        loser had the better score and the wrong doctor was picked."""
        t = make_template(session, is_active=True)
        trainee = make_doctor(session, code="TT", doctor_type=DoctorType.TRAINEE)
        first = make_doctor(session, code="AA", doctor_type=DoctorType.PARTNER, spw="10.0")
        second = make_doctor(session, code="BB", doctor_type=DoctorType.PARTNER, spw="10.0")
        _requires_room(session, t, trainee)
        _pre_assigned(session, t, first, make_room(session, code="D1", room_type=RoomType.D))
        _pre_assigned(session, t, second, make_room(session, code="D2", room_type=RoomType.D))
        make_system_counter(session, first, SystemCounterType.SUPERVISION, raw_count=2)
        make_system_counter(session, second, SystemCounterType.SUPERVISION, raw_count=2)

        ctx, grid, counters = _build(session, config_1wk)
        log = DecisionLog()
        run_phase9c(ctx, grid, counters, log)

        entry = next(e for e in log.entries if e.action == "assign_supervisor")
        assert entry.doctor_id == first.id
        assert "Tied on a weighted score of 0.200 (2): AA; BB" in entry.rationale
        assert entry.rationale.endswith(
            "Decided on: alphabetical order of doctor code (fully tied on every "
            "earlier stage) -- AA."
        )
        assert "alphabetical tie-break" in entry.message

    def test_names_partner_salaried_doctors_kept_out_of_the_pool(self, session, config_1wk):
        # One doctor per exclusion `is_selectable_supervisor` still has --
        # the room criterion is gone, so a C-room Partner is now *in* the
        # pool. The line each gets has to name the reason that actually
        # applied, which is what pairs `_ineligible_lines` to the predicate.
        t = make_template(session, is_active=True)
        trainee = make_doctor(session, code="TT", doctor_type=DoctorType.TRAINEE)
        eligible = make_doctor(session, code="AA", doctor_type=DoctorType.PARTNER, spw="10.0")
        on_duty = make_doctor(session, code="BB", doctor_type=DoctorType.PARTNER, spw="10.0")
        on_leave = make_doctor(session, code="CC", doctor_type=DoctorType.PARTNER, spw="10.0")
        at_home = make_doctor(session, code="DD", doctor_type=DoctorType.PARTNER, spw="10.0")
        on_admin = make_doctor(session, code="EE", doctor_type=DoctorType.PARTNER, spw="10.0")

        _requires_room(session, t, trainee)
        _pre_assigned(session, t, eligible, make_room(session, code="D1", room_type=RoomType.D))
        _requires_room(session, t, on_duty)
        _requires_room(session, t, on_leave)
        make_master_session(
            session, t, at_home, week=1, day=Day.MONDAY, period=Period.AM,
            session_type=MasterSessionType.WFH,
        )
        make_master_session(
            session, t, on_admin, week=1, day=Day.MONDAY, period=Period.AM,
            session_type=MasterSessionType.ADMIN_TIME,
        )
        make_leave(session, on_leave, config_1wk.start_date, period=Period.AM)

        ctx, grid, counters = _build(session, config_1wk)
        # Phase 4 is what normally stamps a role; this phase only reads it.
        grid.get(on_duty.id, 1, Day.MONDAY, Period.AM).role = SessionRole.DUTY_PRIMARY

        log = DecisionLog()
        run_phase9c(ctx, grid, counters, log)

        entry = next(e for e in log.entries if e.action == "assign_supervisor")
        assert entry.doctor_id == eligible.id
        assert (
            "Not in the pool (4): BB: already on duty_primary this session; "
            "CC: on leave; DD: working from home; "
            "EE: template session is admin_time" in entry.rationale
        )

    def test_a_c_room_partner_is_now_in_the_pool(self, session, config_1wk):
        # The counterpart to the test above: the room criterion is gone from
        # `is_selectable_supervisor` (D1), so a Partner pre-assigned a C room
        # is a candidate -- and, being the only one, is selected and moved
        # into SR. The old room-based exclusion line no longer exists.
        t = make_template(session, is_active=True)
        trainee = make_doctor(session, code="TT", doctor_type=DoctorType.TRAINEE)
        c_room_partner = make_doctor(
            session, code="BB", doctor_type=DoctorType.PARTNER, spw="10.0",
        )
        _requires_room(session, t, trainee)
        _pre_assigned(
            session, t, c_room_partner, make_room(session, code="C1", room_type=RoomType.C)
        )
        sr_room = make_room(session, code="SR1", room_type=RoomType.SR)

        ctx, grid, counters = _build(session, config_1wk)
        log = DecisionLog()
        run_phase9c(ctx, grid, counters, log)

        entry = next(e for e in log.entries if e.action == "assign_supervisor")
        assert entry.doctor_id == c_room_partner.id
        assert "Not in the pool" not in entry.rationale
        assert "not a D or SR room" not in entry.rationale
        assert (
            grid.get(c_room_partner.id, 1, Day.MONDAY, Period.AM).assigned_room_id
            == sr_room.id
        )
