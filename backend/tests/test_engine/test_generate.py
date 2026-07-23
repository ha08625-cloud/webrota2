import datetime

from sqlalchemy import select

from app.engine.context import load_context
from app.engine.generate import _write_to_db, generate, scrap_rota
from app.engine.phases.phase2 import run_phase2
from app.engine.datatypes import DecisionLog
from app.models import (
    ClinicCounter,
    RotaClosure,
    RotaConfig,
    RotaGenerationLogEntry,
    RotaSession,
    SystemCounter,
)
from app.models.enums import (
    Day,
    DoctorType,
    DutyType,
    MasterSessionType,
    Period,
    RoomType,
    SystemCounterType,
)

from .factories import (
    make_clinic_type,
    make_closure,
    make_doctor,
    make_duty,
    make_leave,
    make_master_session,
    make_preferred_room,
    make_room,
    make_staging,
    make_staging_session,
    make_system_counter,
    make_template,
)


class TestGenerateEndToEnd:
    def test_full_pipeline_writes_rota_and_counters(self, session, monday):
        """A small but structurally representative fixture: three doctor
        types, a duty assignment, a leave entry, and one room_required
        clinic type. Smaller than the M2 plan's suggested "handful of
        clinic types incl. a multi-slot duty helper type" -- flagged as a
        scope simplification for this step, not a silent shortfall.
        """
        t = make_template(session, is_active=True)
        partner = make_doctor(session, code="AA", doctor_type=DoctorType.PARTNER)
        salaried = make_doctor(session, code="BB", doctor_type=DoctorType.SALARIED)
        trainee = make_doctor(session, code="CC", doctor_type=DoctorType.TRAINEE)
        make_room(session, code="D1", room_type=RoomType.D)
        c_room = make_room(session, code="C1", room_type=RoomType.C)

        for doc in (partner, salaried, trainee):
            make_master_session(
                session, t, doc, week=1, day=Day.MONDAY, period=Period.AM,
                session_type=MasterSessionType.REQUIRES_ROOM,
            )
            make_master_session(
                session, t, doc, week=1, day=Day.MONDAY, period=Period.PM,
                session_type=MasterSessionType.REQUIRES_ROOM,
            )

        make_duty(session, monday, Period.AM, partner, DutyType.PRIMARY)
        make_leave(session, trainee, monday, Period.PM)

        make_clinic_type(
            session, name="Dragon", clinic_priority=10, room_required=True,
            schedules=[(Day.MONDAY, Period.AM)],
            doctor_eligibilities=[(salaried.id, 1)], room_ids=[c_room.id],
        )

        config = RotaConfig(start_date=monday, num_weeks=1, template_start_week=1)
        session.add(config)
        session.flush()

        result = generate(session, config.id)

        assert result.status in ("success", "partial")
        assert result.rota_id is not None
        assert isinstance(result.issues, tuple)

        rota_sessions = session.execute(
            select(RotaSession).where(RotaSession.rota_id == result.rota_id)
        ).scalars().all()
        # 3 doctors x 2 periods (Monday only in this fixture) = 6 slots
        assert len(rota_sessions) == 6

        partner_am = next(
            s for s in rota_sessions if s.doctor_id == partner.id and s.period == Period.AM
        )
        assert partner_am.role.value == "duty_primary"

        salaried_am = next(
            s for s in rota_sessions if s.doctor_id == salaried.id and s.period == Period.AM
        )
        assert salaried_am.clinic_type_id is not None
        assert salaried_am.room_id == c_room.id

        trainee_pm = next(
            s for s in rota_sessions if s.doctor_id == trainee.id and s.period == Period.PM
        )
        assert trainee_pm.room_id is None  # on leave -- never assigned a room

        clinic_counter = session.execute(
            select(ClinicCounter).where(ClinicCounter.doctor_id == salaried.id)
        ).scalar_one()
        assert clinic_counter.raw_count == 1

    def test_template_type_persisted_per_slot(self, session, monday):
        """M3.6: RotaSession.template_type mirrors the master slot's type,
        for both REQUIRES_ROOM and non-room types. NO_SURGERY/ADMIN_TIME
        rows are otherwise byte-identical to a normal unassigned row
        (room_id/clinic_type_id/role all null) - template_type is exactly
        what resolves that ambiguity, so this asserts it lands on the row.
        """
        t = make_template(session, is_active=True)
        doctor = make_doctor(session, code="DD", doctor_type=DoctorType.SALARIED)
        admin_room = make_room(session, code="D2", room_type=RoomType.D)

        make_master_session(
            session, t, doctor, week=1, day=Day.MONDAY, period=Period.AM,
            session_type=MasterSessionType.NO_SURGERY,
        )
        make_master_session(
            session, t, doctor, week=1, day=Day.MONDAY, period=Period.PM,
            session_type=MasterSessionType.ADMIN_TIME, room=admin_room,
        )

        config = RotaConfig(start_date=monday, num_weeks=1, template_start_week=1)
        session.add(config)
        session.flush()

        result = generate(session, config.id)
        assert result.status in ("success", "partial")

        rota_sessions = session.execute(
            select(RotaSession).where(RotaSession.rota_id == result.rota_id)
        ).scalars().all()
        assert len(rota_sessions) == 2

        am = next(s for s in rota_sessions if s.period == Period.AM)
        pm = next(s for s in rota_sessions if s.period == Period.PM)

        assert am.template_type == MasterSessionType.NO_SURGERY
        assert am.role is None
        assert am.room_id is None  # NO_SURGERY never has a room

        assert pm.template_type == MasterSessionType.ADMIN_TIME
        assert pm.role is None
        # Not asserting pm.room_id: whether ADMIN_TIME pre-occupies a room
        # is phase2's concern (_PRE_OCCUPYING_TYPES), not M3.6's - only that
        # template_type itself made it onto the row, for both types here.

    def test_leave_frees_pre_assigned_room_for_reassignment(self, session, monday):
        """Leave-frees-rooms plan, Task 1: a PRE_ASSIGNED slot's room claim
        is skipped when the occupant is on leave, so Phases 7-9A can hand
        the room to another doctor's REQUIRES_ROOM slot in the same
        session. Pins both the grid-level skip and the persisted write:
        doctor A's room_id lands NULL while template_type=PRE_ASSIGNED
        survives on the row, doctor B claims the freed room, and no
        unresolved_room warning fires for doctor A (Phase 12 already
        excludes on-leave slots from that check).
        """
        t = make_template(session, is_active=True)
        doctor_a = make_doctor(session, code="AA", doctor_type=DoctorType.PARTNER)
        doctor_b = make_doctor(session, code="BB", doctor_type=DoctorType.SALARIED)
        room = make_room(session, code="D1", room_type=RoomType.D)

        make_master_session(
            session, t, doctor_a, week=1, day=Day.MONDAY, period=Period.AM,
            session_type=MasterSessionType.PRE_ASSIGNED, room=room,
        )
        make_master_session(
            session, t, doctor_b, week=1, day=Day.MONDAY, period=Period.AM,
            session_type=MasterSessionType.REQUIRES_ROOM,
        )
        make_preferred_room(session, doctor_b, preference_order=1, room=room)
        make_leave(session, doctor_a, monday, Period.AM)

        config = RotaConfig(start_date=monday, num_weeks=1, template_start_week=1)
        session.add(config)
        session.flush()

        result = generate(session, config.id)

        assert result.status in ("success", "partial")
        assert result.rota_id is not None

        rota_sessions = session.execute(
            select(RotaSession).where(RotaSession.rota_id == result.rota_id)
        ).scalars().all()

        a_am = next(s for s in rota_sessions if s.doctor_id == doctor_a.id)
        b_am = next(s for s in rota_sessions if s.doctor_id == doctor_b.id)

        # doctor A's leave releases the pre-assigned room; template_type
        # still shows PRE_ASSIGNED, distinguishing this from an ordinary
        # unassigned row.
        assert a_am.room_id is None
        assert a_am.template_type == MasterSessionType.PRE_ASSIGNED

        # doctor B claims the freed room.
        assert b_am.room_id == room.id

        assert not any(
            i.check == "unresolved_room" and i.message and doctor_a.code in i.message
            for i in result.issues
        )

    def test_failed_status_when_phase0_errors(self, session, monday):
        # No active template at all -> Phase 0 errors -> failed, nothing written
        config = RotaConfig(start_date=monday, num_weeks=1, template_start_week=1)
        session.add(config)
        session.flush()

        result = generate(session, config.id)

        assert result.status == "failed"
        assert result.rota_id is None
        assert any(i.severity == "error" for i in result.issues)

        written = session.execute(select(RotaSession)).scalars().all()
        assert written == []

    def test_unknown_config_id_raises(self, session):
        import pytest
        with pytest.raises(ValueError):
            generate(session, config_id=999999)

    def test_system_counter_persisted_after_displacement(self, session, monday):
        """Isolated fixture forcing a Phase 7 full-day displacement, to
        exercise _write_counters' SystemCounter UPDATE path -- not touched
        by the main end-to-end fixture above, since nothing in it forces a
        room displacement.
        """
        t = make_template(session, is_active=True)
        trainee = make_doctor(session, code="TT", doctor_type=DoctorType.TRAINEE)
        partner = make_doctor(session, code="PP", doctor_type=DoctorType.PARTNER)
        d_room = make_room(session, code="D1", room_type=RoomType.D)
        fallback = make_room(session, code="C1", room_type=RoomType.C)

        make_master_session(
            session, t, trainee, week=1, day=Day.MONDAY, period=Period.AM,
            session_type=MasterSessionType.REQUIRES_ROOM,
        )
        make_master_session(
            session, t, trainee, week=1, day=Day.MONDAY, period=Period.PM,
            session_type=MasterSessionType.REQUIRES_ROOM,
        )
        make_master_session(
            session, t, partner, week=1, day=Day.MONDAY, period=Period.AM,
            session_type=MasterSessionType.PRE_ASSIGNED, room=d_room,
        )
        make_master_session(
            session, t, partner, week=1, day=Day.MONDAY, period=Period.PM,
            session_type=MasterSessionType.PRE_ASSIGNED, room=d_room,
        )
        make_preferred_room(session, partner, preference_order=1, room=fallback)
        # Mirrors M1's seed_system_counters guarantee for an active doctor.
        make_system_counter(session, partner, SystemCounterType.ROOM_MOVE, raw_count=0)
        make_system_counter(session, partner, SystemCounterType.SUPERVISION, raw_count=0)

        config = RotaConfig(start_date=monday, num_weeks=1, template_start_week=1)
        session.add(config)
        session.flush()

        result = generate(session, config.id)

        assert result.rota_id is not None

        room_move = session.execute(
            select(SystemCounter).where(
                SystemCounter.doctor_id == partner.id,
                SystemCounter.counter_type == SystemCounterType.ROOM_MOVE,
            )
        ).scalar_one()
        assert room_move.raw_count == 1

        rota_sessions = session.execute(
            select(RotaSession).where(RotaSession.rota_id == result.rota_id)
        ).scalars().all()
        trainee_am = next(
            s for s in rota_sessions if s.doctor_id == trainee.id and s.period == Period.AM
        )
        assert trainee_am.room_id == d_room.id
        partner_am = next(
            s for s in rota_sessions if s.doctor_id == partner.id and s.period == Period.AM
        )
        assert partner_am.room_id == fallback.id


class TestPhase0DutyIncompatibleSlot:
    """M3.7: duty pre-planned onto a NO_SURGERY/ADMIN_TIME template slot is
    a Phase 0 hard error (same tier as duty-on-leave). WFH is deliberately
    excluded from this block (a WFH slot is overridable in practice - the
    doctor comes in for duty) and is a Phase 12 warning instead - see
    test_phase12.py's TestRoleOnIncompatibleSlot.
    """

    def test_duty_on_no_surgery_blocks(self, session, monday):
        t = make_template(session, is_active=True)
        doctor = make_doctor(session, code="EE", doctor_type=DoctorType.PARTNER)
        make_master_session(
            session, t, doctor, week=1, day=Day.MONDAY, period=Period.AM,
            session_type=MasterSessionType.NO_SURGERY,
        )
        make_duty(session, monday, Period.AM, doctor, DutyType.PRIMARY)

        config = RotaConfig(start_date=monday, num_weeks=1, template_start_week=1)
        session.add(config)
        session.flush()

        result = generate(session, config.id)

        assert result.status == "failed"
        assert result.rota_id is None
        assert any(i.check == "duty_on_incompatible_slot" for i in result.issues)
        written = session.execute(select(RotaSession)).scalars().all()
        assert written == []

    def test_duty_on_admin_time_blocks(self, session, monday):
        t = make_template(session, is_active=True)
        doctor = make_doctor(session, code="FF", doctor_type=DoctorType.PARTNER)
        make_master_session(
            session, t, doctor, week=1, day=Day.MONDAY, period=Period.AM,
            session_type=MasterSessionType.ADMIN_TIME,
        )
        make_duty(session, monday, Period.AM, doctor, DutyType.PRIMARY)

        config = RotaConfig(start_date=monday, num_weeks=1, template_start_week=1)
        session.add(config)
        session.flush()

        result = generate(session, config.id)

        assert result.status == "failed"
        assert any(i.check == "duty_on_incompatible_slot" for i in result.issues)

    def test_duty_on_wfh_does_not_block(self, session, monday):
        t = make_template(session, is_active=True)
        doctor = make_doctor(session, code="GG", doctor_type=DoctorType.PARTNER)
        make_master_session(
            session, t, doctor, week=1, day=Day.MONDAY, period=Period.AM,
            session_type=MasterSessionType.WFH,
        )
        make_duty(session, monday, Period.AM, doctor, DutyType.PRIMARY)

        config = RotaConfig(start_date=monday, num_weeks=1, template_start_week=1)
        session.add(config)
        session.flush()

        result = generate(session, config.id)

        # WFH is deliberately not in the Phase 0 block - generation proceeds
        # (Phase 12's role_on_incompatible_slot warns about it instead).
        assert result.status in ("success", "partial")
        assert result.rota_id is not None
        assert not any(i.check == "duty_on_incompatible_slot" for i in result.issues)


class TestGenerateClosures:
    """M5: _write_to_db snapshots every closed date inside the run's range
    onto RotaClosure, independent of the RotaSession rows themselves (which
    simply omit closed-date slots per Phase 2)."""

    def test_closure_in_range_written_as_rota_closure(self, session, monday):
        t = make_template(session, is_active=True)
        doctor = make_doctor(session, code="AA", doctor_type=DoctorType.PARTNER)
        make_master_session(
            session, t, doctor, week=1, day=Day.TUESDAY, period=Period.AM,
            session_type=MasterSessionType.REQUIRES_ROOM,
        )
        make_closure(session, monday, name="Bank Holiday")

        config = RotaConfig(start_date=monday, num_weeks=1, template_start_week=1)
        session.add(config)
        session.flush()

        result = generate(session, config.id)

        assert result.rota_id is not None
        closures = session.execute(
            select(RotaClosure).where(RotaClosure.rota_id == result.rota_id)
        ).scalars().all()
        assert [c.date for c in closures] == [monday]

    def test_closure_outside_range_not_written(self, session, monday):
        t = make_template(session, is_active=True)
        doctor = make_doctor(session, code="AA", doctor_type=DoctorType.PARTNER)
        make_master_session(
            session, t, doctor, week=1, day=Day.MONDAY, period=Period.AM,
            session_type=MasterSessionType.REQUIRES_ROOM,
        )
        make_closure(session, monday + datetime.timedelta(days=7))  # outside a 1wk run

        config = RotaConfig(start_date=monday, num_weeks=1, template_start_week=1)
        session.add(config)
        session.flush()

        result = generate(session, config.id)

        closures = session.execute(
            select(RotaClosure).where(RotaClosure.rota_id == result.rota_id)
        ).scalars().all()
        assert closures == []

    def test_no_closures_writes_no_rota_closure_rows(self, session, monday):
        t = make_template(session, is_active=True)
        doctor = make_doctor(session, code="AA", doctor_type=DoctorType.PARTNER)
        make_master_session(
            session, t, doctor, week=1, day=Day.MONDAY, period=Period.AM,
            session_type=MasterSessionType.REQUIRES_ROOM,
        )

        config = RotaConfig(start_date=monday, num_weeks=1, template_start_week=1)
        session.add(config)
        session.flush()

        result = generate(session, config.id)

        closures = session.execute(
            select(RotaClosure).where(RotaClosure.rota_id == result.rota_id)
        ).scalars().all()
        assert closures == []

    def test_closed_date_produces_no_session_rows(self, session, monday):
        t = make_template(session, is_active=True)
        doctor = make_doctor(session, code="AA", doctor_type=DoctorType.PARTNER)
        make_master_session(
            session, t, doctor, week=1, day=Day.MONDAY, period=Period.AM,
            session_type=MasterSessionType.REQUIRES_ROOM,
        )
        make_master_session(
            session, t, doctor, week=1, day=Day.TUESDAY, period=Period.AM,
            session_type=MasterSessionType.REQUIRES_ROOM,
        )
        make_closure(session, monday)

        config = RotaConfig(start_date=monday, num_weeks=1, template_start_week=1)
        session.add(config)
        session.flush()

        result = generate(session, config.id)

        rota_sessions = session.execute(
            select(RotaSession).where(RotaSession.rota_id == result.rota_id)
        ).scalars().all()
        assert len(rota_sessions) == 1
        assert rota_sessions[0].day == Day.TUESDAY


class TestGenerationLogPersistence:
    """Task 2: the orchestrator threads an empty DecisionLog through every
    in-scope phase and _write_to_db() persists whatever it collects. No
    phase writes entries yet (that is Task 3), so this exercises the
    persistence path directly: build a minimal grid/counters via the same
    load_context()/run_phase2() pattern the phase tests use, hand
    _write_to_db() a DecisionLog with two manually-added entries, and check
    they round-trip in sequence order and are removed by scrap_rota()'s
    cascade delete.
    """

    def test_log_entries_round_trip_and_scrap_deletes_them(self, session, monday):
        t = make_template(session, is_active=True)
        doctor = make_doctor(session, code="AA", doctor_type=DoctorType.PARTNER)
        make_master_session(
            session, t, doctor, week=1, day=Day.MONDAY, period=Period.AM,
            session_type=MasterSessionType.REQUIRES_ROOM,
        )

        config = RotaConfig(start_date=monday, num_weeks=1, template_start_week=1)
        session.add(config)
        session.flush()

        ctx = load_context(session, config)
        grid, counters = run_phase2(ctx, config, session)

        log = DecisionLog()
        log.add(
            phase="phase5", action="assign_clinic", doctor_id=doctor.id,
            week=1, day=Day.MONDAY, period=Period.AM,
            message="Test entry one.",
        )
        log.add(
            phase="phase9b", action="resolve_swap", doctor_id=doctor.id,
            week=1, day=Day.MONDAY, period=Period.PM,
            message="Test entry two.",
        )

        rota_id = _write_to_db(session, config.id, grid, counters, frozenset(), log)
        session.flush()

        rows = session.execute(
            select(RotaGenerationLogEntry)
            .where(RotaGenerationLogEntry.rota_id == rota_id)
            .order_by(RotaGenerationLogEntry.sequence)
        ).scalars().all()

        assert len(rows) == 2
        assert [r.sequence for r in rows] == [0, 1]
        assert rows[0].phase == "phase5"
        assert rows[0].action == "assign_clinic"
        assert rows[0].message == "Test entry one."
        assert rows[1].phase == "phase9b"
        assert rows[1].action == "resolve_swap"
        assert rows[1].message == "Test entry two."
        assert all(r.rota_id == rota_id for r in rows)

        scrap_rota(session, rota_id)

        remaining = session.execute(
            select(RotaGenerationLogEntry).where(RotaGenerationLogEntry.rota_id == rota_id)
        ).scalars().all()
        assert remaining == []

    def test_full_pipeline_persists_log_entries_in_sequence_order(self, session, monday):
        """Task 3: every in-scope phase now emits real decision log
        entries. Run the actual pipeline (not the phase2-only harness the
        round-trip test above uses) and check the persisted rows are
        non-empty and stored in strict sequence order -- i.e. `sequence`
        is exactly 0..N-1 in row order, matching the order entries were
        added during the run. This does not re-assert per-phase message
        content (that is covered by each phase's own test module); it only
        pins that the full pipeline's output survives the write intact.
        """
        t = make_template(session, is_active=True)
        partner = make_doctor(session, code="AA", doctor_type=DoctorType.PARTNER)
        salaried = make_doctor(session, code="BB", doctor_type=DoctorType.SALARIED)
        trainee = make_doctor(session, code="CC", doctor_type=DoctorType.TRAINEE)
        for doc in (partner, salaried, trainee):
            make_system_counter(session, doc, SystemCounterType.ROOM_MOVE, raw_count=0)
        make_room(session, code="D1", room_type=RoomType.D)
        c_room = make_room(session, code="C1", room_type=RoomType.C)

        for doc in (partner, salaried, trainee):
            make_master_session(
                session, t, doc, week=1, day=Day.MONDAY, period=Period.AM,
                session_type=MasterSessionType.REQUIRES_ROOM,
            )
            make_master_session(
                session, t, doc, week=1, day=Day.MONDAY, period=Period.PM,
                session_type=MasterSessionType.REQUIRES_ROOM,
            )

        make_duty(session, monday, Period.AM, partner, DutyType.PRIMARY)

        make_clinic_type(
            session, name="Dragon", clinic_priority=10, room_required=True,
            schedules=[(Day.MONDAY, Period.AM)],
            doctor_eligibilities=[(salaried.id, 1)], room_ids=[c_room.id],
        )

        config = RotaConfig(start_date=monday, num_weeks=1, template_start_week=1)
        session.add(config)
        session.flush()

        result = generate(session, config.id)
        assert result.status in ("success", "partial")

        rows = session.execute(
            select(RotaGenerationLogEntry)
            .where(RotaGenerationLogEntry.rota_id == result.rota_id)
            .order_by(RotaGenerationLogEntry.sequence)
        ).scalars().all()

        assert len(rows) > 0
        assert [r.sequence for r in rows] == list(range(len(rows)))
        # At least the duty assignment (phase4) and the clinic assignment
        # (phase5) should have made it through -- a loose sanity check that
        # this is real per-phase output, not an artifact of the write path.
        assert any(r.phase == "phase4" and r.action == "assign_duty" for r in rows)
        assert any(r.phase == "phase5" and r.action == "assign_clinic" for r in rows)


class TestGenerateFromStaging:
    """Staging plan, Task 2: a full generate() run over a staging config
    reads the staged rows, not the template's, proving the pipeline
    consumes the copy end to end. `template_start_week` is left at the
    config default of 1 -- staging rows are keyed by generation week and
    template_week() is the identity there (Design Decision 4).
    """

    def test_full_pipeline_reflects_staged_pattern_not_template(self, session, monday):
        t = make_template(session, is_active=True)
        doctor = make_doctor(session, code="AA", doctor_type=DoctorType.PARTNER)
        template_room = make_room(session, code="D1", room_type=RoomType.D)
        staging_room = make_room(session, code="D2", room_type=RoomType.D)

        # Template says NO_SURGERY -- the staged copy overrides it to a
        # PRE_ASSIGNED session in a different room.
        make_master_session(
            session, t, doctor, week=1, day=Day.MONDAY, period=Period.AM,
            session_type=MasterSessionType.NO_SURGERY,
        )

        config = RotaConfig(start_date=monday, num_weeks=1, template_start_week=1)
        session.add(config)
        session.flush()

        staging = make_staging(session, config, t)
        make_staging_session(
            session, staging, doctor, week=1, day=Day.MONDAY, period=Period.AM,
            session_type=MasterSessionType.PRE_ASSIGNED, room=staging_room,
        )

        result = generate(session, config.id)

        assert result.status in ("success", "partial")
        assert result.rota_id is not None

        rota_sessions = session.execute(
            select(RotaSession).where(RotaSession.rota_id == result.rota_id)
        ).scalars().all()
        assert len(rota_sessions) == 1

        row = rota_sessions[0]
        assert row.template_type == MasterSessionType.PRE_ASSIGNED
        assert row.room_id == staging_room.id
        assert row.room_id != template_room.id