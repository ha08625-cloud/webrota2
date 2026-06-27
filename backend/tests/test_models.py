"""Model-level tests: CRUD, relationships, unique/check constraints."""
import datetime
from decimal import Decimal

import pytest
from sqlalchemy.exc import IntegrityError

from app.models import (
    ClinicCounter,
    ClinicType,
    Doctor,
    DoctorPreferredRoom,
    MasterRotaSession,
    MasterRotaTemplate,
    Room,
    RotaConfig,
)
from app.models.enums import (
    ClinicCounterMode,
    Day,
    DoctorType,
    MasterSessionType,
    Period,
    RoomType,
    Site,
)


def _room(session, code="D4", rt=RoomType.D, site=Site.SHC):
    r = Room(code=code, room_type=rt, site=site)
    session.add(r)
    session.flush()
    return r


def _doctor(session, code="AA", dt=DoctorType.PARTNER, spw="10.0"):
    d = Doctor(code=code, doctor_type=dt, sessions_per_week=Decimal(spw), active=True)
    session.add(d)
    session.flush()
    return d


def _clinic(session, name="Dragon", mode=ClinicCounterMode.SHARED):
    c = ClinicType(name=name, clinic_priority=10, counter_mode=mode)
    session.add(c)
    session.flush()
    return c


# --- CRUD + relationships ---

def test_room_crud(session):
    r = _room(session)
    assert session.get(Room, r.id).code == "D4"


def test_preferred_rooms_relationship_ordered(session):
    r1 = _room(session, "D4")
    r2 = _room(session, "C1", RoomType.C, Site.CUTTESLOWE)
    d = _doctor(session)
    d.preferred_rooms.append(DoctorPreferredRoom(preference_order=2, room_id=r2.id))
    d.preferred_rooms.append(DoctorPreferredRoom(preference_order=1, room_id=r1.id))
    session.flush()
    session.refresh(d)
    assert [p.preference_order for p in d.preferred_rooms] == [1, 2]
    assert d.preferred_rooms[0].room_id == r1.id


# --- unique constraints ---

def test_doctor_code_unique(session):
    _doctor(session, "AA")
    session.add(Doctor(code="AA", doctor_type=DoctorType.SALARIED))
    with pytest.raises(IntegrityError):
        session.flush()


def test_master_session_unique_with_week(session):
    d = _doctor(session)
    t = MasterRotaTemplate(name="Default")
    session.add(t)
    session.flush()

    def mrs(week):
        return MasterRotaSession(
            template_id=t.id, doctor_id=d.id, week=week, day=Day.MONDAY,
            period=Period.AM, session_type=MasterSessionType.NO_SURGERY,
        )

    session.add(mrs(1))
    session.add(mrs(2))  # same doctor/day/period, different week -> allowed
    session.flush()

    session.add(mrs(1))  # duplicate slot -> rejected
    with pytest.raises(IntegrityError):
        session.flush()


# --- XOR check constraints ---

def test_dpr_xor_both_set_rejected(session):
    r = _room(session)
    d = _doctor(session)
    session.add(DoctorPreferredRoom(
        doctor_id=d.id, preference_order=1, room_id=r.id, room_type=RoomType.D,
    ))
    with pytest.raises(IntegrityError):
        session.flush()


def test_dpr_xor_neither_set_rejected(session):
    d = _doctor(session)
    session.add(DoctorPreferredRoom(doctor_id=d.id, preference_order=1))
    with pytest.raises(IntegrityError):
        session.flush()


# --- counter_mode default ---

def test_clinic_type_counter_mode_defaults_shared(session):
    c = ClinicType(name="DutyHelper", clinic_priority=99)
    session.add(c)
    session.flush()
    session.refresh(c)
    assert c.counter_mode == ClinicCounterMode.SHARED


# --- ClinicCounter shared vs per_slot ---

def test_clinic_counter_shared_unique(session):
    d = _doctor(session)
    c = _clinic(session)
    session.add(ClinicCounter(doctor_id=d.id, clinic_type_id=c.id, raw_count=0))
    session.flush()
    session.add(ClinicCounter(doctor_id=d.id, clinic_type_id=c.id, raw_count=0))
    with pytest.raises(IntegrityError):
        session.flush()


def test_clinic_counter_per_slot_unique_and_distinct_slots_allowed(session):
    d = _doctor(session)
    c = _clinic(session, mode=ClinicCounterMode.PER_SLOT)
    session.add(ClinicCounter(
        doctor_id=d.id, clinic_type_id=c.id, day=Day.MONDAY, period=Period.AM,
    ))
    session.add(ClinicCounter(
        doctor_id=d.id, clinic_type_id=c.id, day=Day.WEDNESDAY, period=Period.AM,
    ))
    session.flush()  # different slots -> allowed

    session.add(ClinicCounter(
        doctor_id=d.id, clinic_type_id=c.id, day=Day.MONDAY, period=Period.AM,
    ))
    with pytest.raises(IntegrityError):
        session.flush()


def test_clinic_counter_day_period_check(session):
    d = _doctor(session)
    c = _clinic(session)
    session.add(ClinicCounter(
        doctor_id=d.id, clinic_type_id=c.id, day=Day.MONDAY, period=None,
    ))
    with pytest.raises(IntegrityError):
        session.flush()


# --- RotaConfig / MasterRotaSession check constraints ---

def test_rota_config_num_weeks_check(session):
    session.add(RotaConfig(
        start_date=datetime.date(2026, 1, 5), num_weeks=3, template_start_week=1,
    ))
    with pytest.raises(IntegrityError):
        session.flush()


def test_rota_config_template_start_week_check(session):
    session.add(RotaConfig(
        start_date=datetime.date(2026, 1, 5), num_weeks=2, template_start_week=5,
    ))
    with pytest.raises(IntegrityError):
        session.flush()


def test_master_session_week_check(session):
    d = _doctor(session)
    t = MasterRotaTemplate(name="Default")
    session.add(t)
    session.flush()
    session.add(MasterRotaSession(
        template_id=t.id, doctor_id=d.id, week=5, day=Day.MONDAY,
        period=Period.AM, session_type=MasterSessionType.NO_SURGERY,
    ))
    with pytest.raises(IntegrityError):
        session.flush()


# --- weighted score (computed at query time) ---

def test_weighted_clinic_score(session):
    d = _doctor(session, spw="8.0")
    c = _clinic(session)
    cc = ClinicCounter(doctor_id=d.id, clinic_type_id=c.id, raw_count=4)
    session.add(cc)
    session.flush()
    weighted = cc.raw_count / float(d.sessions_per_week)
    assert weighted == 0.5