"""The guarantee that no generation phase ever allocates a TR room.

`_shared.NON_ALLOCATABLE_ROOM_TYPES` names the rule; it is not read by any
phase, because the rule is *absence* from the room-type collections the
phases reach rooms through, and absence is not something code can state.
This file is the other half, in two parts:

  - Four disjointness assertions, one per named room-type tuple. These are
    the mirror of `test_inert.py`: add TR to any of those tuples and this
    file fails, which is the only failure mode a constant alone cannot
    catch.
  - One full generation under real room pressure. The tuple assertions say
    nothing about the inline `rooms_by_type.get(RoomType.D, ())` lookups or
    the preference walks, so the generation test is what covers those: it
    builds a Monday where the four TR rooms are the *only* free rooms left
    and asserts every search would rather leave a doctor roomless than use
    one.
"""
from sqlalchemy import select

from app.engine import room_relocation
from app.engine.generate import generate
from app.engine.phases import phase7_9a, phase9c
from app.engine.phases._shared import NON_ALLOCATABLE_ROOM_TYPES
from app.models import RotaConfig, RotaSession
from app.models.enums import (
    Day,
    DoctorType,
    DutyType,
    MasterSessionType,
    Period,
    RoomType,
    Site,
    SystemCounterType,
)

from .factories import (
    make_clinic_type,
    make_doctor,
    make_duty,
    make_master_session,
    make_preferred_room,
    make_room,
    make_system_counter,
    make_template,
)


def test_non_allocatable_rooms_are_not_in_the_pass1_fallback_pool():
    assert set(NON_ALLOCATABLE_ROOM_TYPES).isdisjoint(
        phase7_9a._ROOM_MOVE_FALLBACK_TYPES
    )


def test_non_allocatable_rooms_are_not_in_the_pass3_fallback_order():
    assert set(NON_ALLOCATABLE_ROOM_TYPES).isdisjoint(
        phase7_9a._PASS3_FALLBACK_TYPE_ORDER
    )


def test_non_allocatable_rooms_are_not_a_relocation_destination():
    assert set(NON_ALLOCATABLE_ROOM_TYPES).isdisjoint(
        room_relocation._ROOM_MOVE_FALLBACK_TYPES
    )


def test_non_allocatable_rooms_never_seat_a_supervisor():
    assert set(NON_ALLOCATABLE_ROOM_TYPES).isdisjoint(
        phase9c._SUPERVISOR_ROOM_TYPES
    )


class TestGenerationNeverSeatsAnyoneInATreatmentRoom:
    def test_tr_rooms_stay_empty_when_they_are_the_only_rooms_left(
        self, session, monday
    ):
        """A Monday deliberately short of rooms, with four TR rooms free.

        Two D rooms serve a duty doctor, a pre-assigned Salaried doctor, two
        Trainees, an AHP and a Salaried clinic candidate, so every search
        that can fall back to another room runs and finds nothing:

          - Phase 4 rooms the duty doctor in the one free D room.
          - Phase 5's displaced-occupant walk (preference list only).
          - Pass 1's full-day receiving-room pool (C/W/SR).
          - Pass 2's `find_relocation_room` fallback (C/W/SR).
          - Pass 3's forced-room order (D > C > W > SR).

        The three warnings asserted at the end are what prove the searches
        were genuinely exhausted rather than satisfied early: doctors end
        the run roomless while four empty rooms sit in the grid, which is
        the correct outcome and the whole point of the TR type.
        """
        t = make_template(session, is_active=True)
        partner = make_doctor(session, code="AA", doctor_type=DoctorType.PARTNER)
        salaried = make_doctor(session, code="BB", doctor_type=DoctorType.SALARIED)
        trainee_1 = make_doctor(session, code="CC", doctor_type=DoctorType.TRAINEE)
        trainee_2 = make_doctor(session, code="DD", doctor_type=DoctorType.TRAINEE)
        ahp = make_doctor(session, code="EE", doctor_type=DoctorType.AHP)
        clinician = make_doctor(session, code="FF", doctor_type=DoctorType.SALARIED)
        nurse = make_doctor(session, code="NN", doctor_type=DoctorType.NURSE)

        d1 = make_room(session, code="D1", room_type=RoomType.D)
        d2 = make_room(session, code="D2", room_type=RoomType.D)
        # The four rooms this ticket adds, and the only free rooms in the
        # fixture. No C/W/SR room exists, so every fallback pool in the
        # engine is empty and a TR room is the only thing a phase could
        # reach for if any of them could see one.
        tr1 = make_room(session, code="TR1", room_type=RoomType.TR, site=Site.SHC)
        tr_rooms = [tr1] + [
            make_room(session, code=code_, room_type=RoomType.TR, site=site)
            for code_, site in (
                ("TR2", Site.SHC), ("TR3", Site.SHC), ("CK", Site.CUTTESLOWE),
            )
        ]
        tr_room_ids = {r.id for r in tr_rooms}

        everyone = (partner, salaried, trainee_1, trainee_2, ahp, clinician, nurse)
        for doc in everyone:
            for counter_type in SystemCounterType:
                make_system_counter(session, doc, counter_type)

        for doc in (partner, trainee_1, trainee_2, ahp, clinician):
            for period in (Period.AM, Period.PM):
                make_master_session(
                    session, t, doc, week=1, day=Day.MONDAY, period=period,
                    session_type=MasterSessionType.REQUIRES_ROOM,
                )
        # The Salaried doctor holds D2 all day from Phase 2, so Passes 1
        # and 2 have a real victim to displace -- and nowhere to put them.
        for period in (Period.AM, Period.PM):
            make_master_session(
                session, t, salaried, week=1, day=Day.MONDAY, period=period,
                session_type=MasterSessionType.PRE_ASSIGNED, room=d2,
            )
        # The nurse is in TR1 the way a human puts them there: a master
        # rota row. Nothing in the run may take it off them.
        for period in (Period.AM, Period.PM):
            make_master_session(
                session, t, nurse, week=1, day=Day.MONDAY, period=period,
                session_type=MasterSessionType.PRE_ASSIGNED, room=tr1,
            )

        make_duty(session, monday, Period.AM, partner, DutyType.PRIMARY)
        make_preferred_room(session, partner, preference_order=1, room=d1)
        make_preferred_room(session, salaried, preference_order=1, room=d1)

        # Phase 5: the clinic's only eligible room is the one the Salaried
        # doctor is sitting in, so the displaced-occupant search runs.
        make_clinic_type(
            session, name="Dragon", clinic_priority=10, room_required=True,
            schedules=[(Day.MONDAY, Period.AM)],
            doctor_eligibilities=[(clinician.id, 1)], room_ids=[d2.id],
        )

        config = RotaConfig(start_date=monday, num_weeks=1, template_start_week=1)
        session.add(config)
        session.flush()

        result = generate(session, config.id)
        assert result.rota_id is not None

        rota_sessions = session.execute(
            select(RotaSession).where(RotaSession.rota_id == result.rota_id)
        ).scalars().all()

        # The nurse keeps the room the master rota gave them.
        nurse_rows = [s for s in rota_sessions if s.doctor_id == nurse.id]
        assert len(nurse_rows) == 2
        assert all(row.room_id == tr1.id for row in nurse_rows)

        # Nobody else is in any TR room -- not TR1, and not the three that
        # stood empty through the whole run.
        assert not any(
            row.room_id in tr_room_ids
            for row in rota_sessions
            if row.doctor_id != nurse.id
        )

        # Proof the fixture was tight enough to matter: doctors finished
        # the run roomless rather than being seated in an empty TR room.
        checks = {issue.check for issue in result.issues}
        assert "no_full_day_room" in checks
        assert "no_single_session_room" in checks
        assert "no_partner_salaried_room" in checks

        # And the three empty TR rooms were never touched at all.
        assert not any(
            row.room_id in (tr_room_ids - {tr1.id}) for row in rota_sessions
        )
