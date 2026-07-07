from sqlalchemy import select

from app.engine.generate import generate
from app.models import ClinicCounter, RotaConfig, RotaSession, SystemCounter
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
    make_doctor,
    make_duty,
    make_leave,
    make_master_session,
    make_preferred_room,
    make_room,
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