"""Small, terse constructors for building engine test fixtures inline.

Nothing here is seeded from CSV — every engine test builds only the rows it
needs to exercise the phase under test, per the M2 plan's fixture strategy.
Each function adds and flushes so the returned object always has an `id`.
"""
from __future__ import annotations

import datetime
import itertools
from decimal import Decimal

from app.models import (
    ClinicCounter,
    ClinicType,
    ClinicTypeDoctorEligibility,
    ClinicTypeRoomEligibility,
    ClinicTypeSchedule,
    Doctor,
    DoctorPreferredRoom,
    DutyAssignment,
    LeaveEntry,
    MasterRotaSession,
    MasterRotaTemplate,
    PracticeClosure,
    Room,
    RotaStaging,
    RotaStagingSession,
    SystemCounter,
)
from app.models.enums import (
    Day,
    DoctorType,
    DutyType,
    MasterSessionType,
    Period,
    RoomType,
    Site,
    SupervisionPreference,
)

# clinic_types.clinic_priority now has a partial unique index over enabled
# rows (migration 005). Tests that don't care about a specific priority
# value should not all default to the same number -- this counter hands out
# a fresh value each call so multiple enabled ClinicType rows in one test
# never collide. Tests asserting priority-dependent behaviour still pass an
# explicit clinic_priority and are unaffected.
_priority_counter = itertools.count(1)


def make_room(session, code="D1", room_type=RoomType.D, site=Site.SHC) -> Room:
    r = Room(code=code, room_type=room_type, site=site)
    session.add(r)
    session.flush()
    return r


def make_doctor(
    session, code="AA", doctor_type=DoctorType.PARTNER, spw="10.0", active=True,
    supervision_preference=SupervisionPreference.NORMAL,
) -> Doctor:
    d = Doctor(
        code=code, doctor_type=doctor_type,
        sessions_per_week=Decimal(spw), active=active,
        supervision_preference=supervision_preference,
    )
    session.add(d)
    session.flush()
    return d


def make_clinic_type(
    session,
    name="Dragon",
    clinic_priority=None,
    is_enabled=True,
    room_required=False,
    category=None,
    schedules=(),             # iterable of (Day, Period)
    doctor_eligibilities=(),  # iterable of (doctor_id, doctor_priority)
    room_ids=(),              # iterable of concrete room_id
    room_types=(),            # iterable of RoomType
) -> ClinicType:
    if clinic_priority is None:
        clinic_priority = next(_priority_counter)
    ct = ClinicType(
        name=name, clinic_priority=clinic_priority, is_enabled=is_enabled,
        room_required=room_required, category=category,
    )
    session.add(ct)
    session.flush()

    for day, period in schedules:
        session.add(ClinicTypeSchedule(clinic_type_id=ct.id, day=day, period=period))
    for doctor_id, priority in doctor_eligibilities:
        session.add(ClinicTypeDoctorEligibility(
            clinic_type_id=ct.id, doctor_id=doctor_id, doctor_priority=priority,
        ))
    for room_id in room_ids:
        session.add(ClinicTypeRoomEligibility(clinic_type_id=ct.id, room_id=room_id))
    for room_type in room_types:
        session.add(ClinicTypeRoomEligibility(clinic_type_id=ct.id, room_type=room_type))
    session.flush()
    return ct


def make_leave(session, doctor, date_: datetime.date, period=Period.AM) -> LeaveEntry:
    e = LeaveEntry(doctor_id=doctor.id, date=date_, period=period)
    session.add(e)
    session.flush()
    return e


def make_duty(
    session, date_: datetime.date, period, doctor, duty_type=DutyType.PRIMARY
) -> DutyAssignment:
    d = DutyAssignment(date=date_, period=period, doctor_id=doctor.id, duty_type=duty_type)
    session.add(d)
    session.flush()
    return d


def make_template(session, name="Default", is_active=True) -> MasterRotaTemplate:
    t = MasterRotaTemplate(name=name, is_active=is_active)
    session.add(t)
    session.flush()
    return t


def make_master_session(
    session, template, doctor, week, day, period,
    session_type=MasterSessionType.NO_SURGERY, room=None,
) -> MasterRotaSession:
    s = MasterRotaSession(
        template_id=template.id, doctor_id=doctor.id, week=week, day=day, period=period,
        session_type=session_type, room_id=(room.id if room is not None else None),
    )
    session.add(s)
    session.flush()
    return s


def make_clinic_counter(session, doctor, clinic_type, raw_count=0) -> ClinicCounter:
    c = ClinicCounter(doctor_id=doctor.id, clinic_type_id=clinic_type.id, raw_count=raw_count)
    session.add(c)
    session.flush()
    return c


def make_system_counter(session, doctor, counter_type, raw_count=0) -> SystemCounter:
    c = SystemCounter(doctor_id=doctor.id, counter_type=counter_type, raw_count=raw_count)
    session.add(c)
    session.flush()
    return c


def make_preferred_room(
    session, doctor, preference_order, room=None, room_type=None
) -> DoctorPreferredRoom:
    p = DoctorPreferredRoom(
        doctor_id=doctor.id, preference_order=preference_order,
        room_id=(room.id if room is not None else None),
        room_type=room_type,
    )
    session.add(p)
    session.flush()
    return p


def make_closure(session, date_: datetime.date, name=None) -> PracticeClosure:
    c = PracticeClosure(date=date_, name=name)
    session.add(c)
    session.flush()
    return c


def make_staging(session, config, template, completed_at=None) -> RotaStaging:
    s = RotaStaging(
        config_id=config.id, source_template_id=template.id, completed_at=completed_at,
    )
    session.add(s)
    session.flush()
    return s


def make_staging_session(
    session, staging, doctor, week, day, period,
    session_type=MasterSessionType.NO_SURGERY, room=None,
) -> RotaStagingSession:
    s = RotaStagingSession(
        staging_id=staging.id, doctor_id=doctor.id, week=week, day=day, period=period,
        session_type=session_type, room_id=(room.id if room is not None else None),
    )
    session.add(s)
    session.flush()
    return s