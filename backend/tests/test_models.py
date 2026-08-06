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
    GeneratedRota,
    MasterRotaSession,
    MasterRotaTemplate,
    PracticeClosure,
    ReceptionCoverageRule,
    ReceptionMasterSession,
    ReceptionRota,
    ReceptionRotaSession,
    ReceptionStaff,
    RecurringNote,
    RecurringNoteDoctor,
    RecurringNoteWeek,
    Room,
    RotaClosure,
    RotaConfig,
    RotaGenerationLogEntry,
    RotaStaging,
    RotaStagingSession,
)
from app.models.enums import (
    Day,
    DoctorType,
    MasterSessionType,
    Period,
    ReceptionRole,
    RoomType,
    RotaStatus,
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


def _clinic(session, name="Dragon"):
    c = ClinicType(name=name, clinic_priority=10)
    session.add(c)
    session.flush()
    return c


# --- CRUD + relationships ---

def test_doctor_type_includes_locum():
    assert DoctorType.LOCUM.value == "Locum"
    assert DoctorType.LOCUM in DoctorType


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


# --- ClinicCounter: shared-only, one row per (doctor, clinic_type) ---

def test_clinic_counter_unique(session):
    d = _doctor(session)
    c = _clinic(session)
    session.add(ClinicCounter(doctor_id=d.id, clinic_type_id=c.id, raw_count=0))
    session.flush()
    session.add(ClinicCounter(doctor_id=d.id, clinic_type_id=c.id, raw_count=0))
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


# --- PracticeClosure / RotaClosure (M5 bank-holiday weeks) ---

def _rota(session, start=datetime.date(2026, 1, 5)):
    config = RotaConfig(start_date=start, num_weeks=1, template_start_week=1)
    session.add(config)
    session.flush()
    rota = GeneratedRota(config_id=config.id, status=RotaStatus.DRAFT)
    session.add(rota)
    session.flush()
    return rota


def test_practice_closure_date_and_period_unique(session):
    session.add(PracticeClosure(
        date=datetime.date(2026, 4, 6), period=Period.AM, name="Easter Monday"
    ))
    session.flush()
    session.add(PracticeClosure(date=datetime.date(2026, 4, 6), period=Period.AM))
    with pytest.raises(IntegrityError):
        session.flush()


def test_practice_closure_other_period_same_date_allowed(session):
    session.add(PracticeClosure(date=datetime.date(2026, 4, 6), period=Period.AM))
    session.add(PracticeClosure(date=datetime.date(2026, 4, 6), period=Period.PM))
    session.flush()  # no error: uniqueness is per (date, period)


def test_rota_closure_unique_per_rota_date_and_period(session):
    rota = _rota(session)
    session.add(RotaClosure(rota_id=rota.id, date=datetime.date(2026, 1, 5), period=Period.AM))
    session.flush()
    session.add(RotaClosure(rota_id=rota.id, date=datetime.date(2026, 1, 5), period=Period.AM))
    with pytest.raises(IntegrityError):
        session.flush()


def test_rota_closure_other_period_same_date_allowed(session):
    rota = _rota(session)
    session.add(RotaClosure(rota_id=rota.id, date=datetime.date(2026, 1, 5), period=Period.AM))
    session.add(RotaClosure(rota_id=rota.id, date=datetime.date(2026, 1, 5), period=Period.PM))
    session.flush()  # no error: uniqueness is per (rota_id, date, period)


def test_rota_closure_same_date_different_rota_allowed(session):
    rota_a = _rota(session)
    rota_b = _rota(session)
    session.add(RotaClosure(rota_id=rota_a.id, date=datetime.date(2026, 1, 5), period=Period.AM))
    session.add(RotaClosure(rota_id=rota_b.id, date=datetime.date(2026, 1, 5), period=Period.AM))
    session.flush()  # no error: uniqueness is per (rota_id, date, period)


def test_rota_closure_cascades_on_rota_delete(session):
    rota = _rota(session)
    session.add(RotaClosure(rota_id=rota.id, date=datetime.date(2026, 1, 5), period=Period.AM))
    session.flush()

    session.delete(rota)
    session.flush()

    remaining = session.query(RotaClosure).filter_by(rota_id=rota.id).all()
    assert remaining == []


def test_deleting_practice_closure_does_not_affect_rota_closure_snapshot(session):
    """Decision 4 / plan review item 1: PracticeClosure and RotaClosure are
    independent tables at the model layer -- there is no FK between them, so
    deleting a PracticeClosure can never cascade into or orphan a
    RotaClosure snapshot row."""
    pc = PracticeClosure(date=datetime.date(2026, 1, 5), period=Period.AM, name="Test closure")
    session.add(pc)
    session.flush()

    rota = _rota(session)
    session.add(RotaClosure(rota_id=rota.id, date=datetime.date(2026, 1, 5), period=Period.AM))
    session.flush()

    session.delete(pc)
    session.flush()

    snapshot = session.query(RotaClosure).filter_by(rota_id=rota.id).one()
    assert snapshot.date == datetime.date(2026, 1, 5)
    assert snapshot.period == Period.AM


# --- RotaGenerationLogEntry (decision log, Task 1) ---

def _log_entry(rota, sequence=0, phase="phase5", action="assign_clinic", **kwargs):
    return RotaGenerationLogEntry(
        rota_id=rota.id, sequence=sequence, phase=phase, action=action,
        message=kwargs.pop("message", "Dr AA assigned to Dragon Monday AM"),
        **kwargs,
    )


def test_generation_log_round_trip_ordered_by_sequence(session):
    rota = _rota(session)
    session.add(_log_entry(rota, sequence=1, message="second"))
    session.add(_log_entry(rota, sequence=0, message="first"))
    session.flush()
    session.refresh(rota)

    rows = (
        session.query(RotaGenerationLogEntry)
        .filter_by(rota_id=rota.id)
        .order_by(RotaGenerationLogEntry.sequence)
        .all()
    )
    assert [r.message for r in rows] == ["first", "second"]


def test_generation_log_nullable_fields_default_none(session):
    rota = _rota(session)
    entry = _log_entry(rota)
    session.add(entry)
    session.flush()
    session.refresh(entry)

    assert entry.week is None
    assert entry.day is None
    assert entry.period is None
    assert entry.doctor_id is None
    assert entry.related_doctor_id is None
    assert entry.room_id is None
    assert entry.related_room_id is None
    assert entry.clinic_type_id is None


def test_generation_log_stores_full_entry(session):
    rota = _rota(session)
    entry = _log_entry(
        rota, phase="phase7_9a", action="displace_room",
        week=1, day=Day.MONDAY, period=Period.AM,
        doctor_id=1, related_doctor_id=2, room_id=101, related_room_id=102,
        message="Dr AA displaced Dr BB from D4 to D5",
    )
    session.add(entry)
    session.flush()
    session.refresh(entry)

    assert entry.phase == "phase7_9a"
    assert entry.action == "displace_room"
    assert entry.week == 1
    assert entry.day == Day.MONDAY
    assert entry.period == Period.AM
    assert entry.doctor_id == 1
    assert entry.related_doctor_id == 2
    assert entry.room_id == 101
    assert entry.related_room_id == 102


def test_generation_log_sequence_unique_per_rota(session):
    rota = _rota(session)
    session.add(_log_entry(rota, sequence=0))
    session.flush()
    session.add(_log_entry(rota, sequence=0))
    with pytest.raises(IntegrityError):
        session.flush()


def test_generation_log_same_sequence_different_rota_allowed(session):
    rota_a = _rota(session)
    rota_b = _rota(session)
    session.add(_log_entry(rota_a, sequence=0))
    session.add(_log_entry(rota_b, sequence=0))
    session.flush()  # no error: uniqueness is per (rota_id, sequence)


def test_generation_log_cascades_on_rota_delete(session):
    rota = _rota(session)
    session.add(_log_entry(rota, sequence=0))
    session.flush()

    session.delete(rota)
    session.flush()

    remaining = session.query(RotaGenerationLogEntry).filter_by(rota_id=rota.id).all()
    assert remaining == []


def test_generation_log_entries_via_relationship(session):
    rota = _rota(session)
    session.add(_log_entry(rota, sequence=0, message="first"))
    session.add(_log_entry(rota, sequence=1, message="second"))
    session.flush()
    session.refresh(rota)

    assert len(rota.generation_log) == 2


# --- RotaStaging / RotaStagingSession (staging plan, Task 1) ---

def _template(session, name="Default"):
    t = MasterRotaTemplate(name=name)
    session.add(t)
    session.flush()
    return t


def _config(session, start=datetime.date(2026, 4, 6)):
    config = RotaConfig(start_date=start, num_weeks=1, template_start_week=1)
    session.add(config)
    session.flush()
    return config


def _staging(session, template=None, config=None):
    template = template or _template(session)
    config = config or _config(session)
    staging = RotaStaging(config_id=config.id, source_template_id=template.id)
    session.add(staging)
    session.flush()
    return staging


def test_staging_round_trip_with_sessions(session):
    d = _doctor(session)
    r = _room(session)
    staging = _staging(session)
    session.add(RotaStagingSession(
        staging_id=staging.id, doctor_id=d.id, week=1, day=Day.MONDAY,
        period=Period.AM, session_type=MasterSessionType.REQUIRES_ROOM,
        room_id=r.id,
    ))
    session.flush()
    session.refresh(staging)

    assert len(staging.sessions) == 1
    assert staging.sessions[0].doctor_id == d.id
    assert staging.sessions[0].room_id == r.id
    assert staging.completed_at is None


def test_staging_session_slot_unique(session):
    d = _doctor(session)
    staging = _staging(session)

    def rss():
        return RotaStagingSession(
            staging_id=staging.id, doctor_id=d.id, week=1, day=Day.MONDAY,
            period=Period.AM, session_type=MasterSessionType.NO_SURGERY,
        )

    session.add(rss())
    session.flush()

    session.add(rss())  # duplicate slot -> rejected
    with pytest.raises(IntegrityError):
        session.flush()


def test_staging_session_week_check(session):
    d = _doctor(session)
    staging = _staging(session)
    session.add(RotaStagingSession(
        staging_id=staging.id, doctor_id=d.id, week=5, day=Day.MONDAY,
        period=Period.AM, session_type=MasterSessionType.NO_SURGERY,
    ))
    with pytest.raises(IntegrityError):
        session.flush()


def test_staging_cascades_sessions_on_delete(session):
    d = _doctor(session)
    staging = _staging(session)
    session.add(RotaStagingSession(
        staging_id=staging.id, doctor_id=d.id, week=1, day=Day.MONDAY,
        period=Period.AM, session_type=MasterSessionType.NO_SURGERY,
    ))
    session.flush()

    session.delete(staging)
    session.flush()

    remaining = session.query(RotaStagingSession).filter_by(staging_id=staging.id).all()
    assert remaining == []


def test_staging_config_id_unique(session):
    config = _config(session)
    _staging(session, config=config)

    session.add(RotaStaging(
        config_id=config.id, source_template_id=_template(session, "Second").id,
    ))
    with pytest.raises(IntegrityError):
        session.flush()

# --- RecurringNote and children (recurring notes plan, Task 1) ---

def _note(session, text="Partners meeting", day=Day.MONDAY, period=Period.PM):
    n = RecurringNote(text=text, day=day, period=period)
    session.add(n)
    session.flush()
    return n


def test_recurring_note_round_trip_with_doctors_and_weeks(session):
    d1 = _doctor(session, "AA")
    d2 = _doctor(session, "BB")
    note = _note(session)
    note.doctors.append(RecurringNoteDoctor(doctor_id=d1.id))
    note.doctors.append(RecurringNoteDoctor(doctor_id=d2.id))
    note.weeks.append(RecurringNoteWeek(template_week=1))
    note.weeks.append(RecurringNoteWeek(template_week=3))
    session.flush()
    session.refresh(note)

    assert note.text == "Partners meeting"
    assert note.day == Day.MONDAY
    assert note.period == Period.PM
    assert note.is_active is True  # Python-side default
    assert {rnd.doctor_id for rnd in note.doctors} == {d1.id, d2.id}
    assert {rnw.template_week for rnw in note.weeks} == {1, 3}


def test_recurring_note_cascades_both_child_sets_on_delete(session):
    d = _doctor(session)
    note = _note(session)
    note.doctors.append(RecurringNoteDoctor(doctor_id=d.id))
    note.weeks.append(RecurringNoteWeek(template_week=2))
    session.flush()
    note_id = note.id

    session.delete(note)
    session.flush()

    assert session.query(RecurringNoteDoctor).filter_by(note_id=note_id).all() == []
    assert session.query(RecurringNoteWeek).filter_by(note_id=note_id).all() == []


@pytest.mark.parametrize("bad_week", [0, 5])
def test_recurring_note_week_check(session, bad_week):
    note = _note(session)
    session.add(RecurringNoteWeek(note_id=note.id, template_week=bad_week))
    with pytest.raises(IntegrityError):
        session.flush()


def test_recurring_note_week_unique_per_note(session):
    note = _note(session)
    session.add(RecurringNoteWeek(note_id=note.id, template_week=1))
    session.flush()
    session.add(RecurringNoteWeek(note_id=note.id, template_week=1))
    with pytest.raises(IntegrityError):
        session.flush()


def test_recurring_note_doctor_unique_per_note(session):
    d = _doctor(session)
    note = _note(session)
    session.add(RecurringNoteDoctor(note_id=note.id, doctor_id=d.id))
    session.flush()
    session.add(RecurringNoteDoctor(note_id=note.id, doctor_id=d.id))
    with pytest.raises(IntegrityError):
        session.flush()


def test_recurring_notes_may_overlap_on_same_day_and_period(session):
    """Design Decision 9: no uniqueness rule across notes. Two notes for the
    same doctor, week, day and period are legal at the data layer -- Phase 2
    concatenates them by note id ascending rather than rejecting either."""
    d = _doctor(session)
    for text in ("Partners meeting", "Practice meeting"):
        note = _note(session, text=text)
        note.doctors.append(RecurringNoteDoctor(doctor_id=d.id))
        note.weeks.append(RecurringNoteWeek(template_week=1))
    session.flush()  # no error

    assert session.query(RecurringNote).count() == 2


def test_recurring_note_doctor_fk_enforced(session):
    """FK enforcement relies on the test engine's PRAGMA foreign_keys=ON;
    the dev SQLite engine in database.py does not set it."""
    note = _note(session)
    session.add(RecurringNoteDoctor(note_id=note.id, doctor_id=9999))
    with pytest.raises(IntegrityError):
        session.flush()


# --- RotaStaging.source_template_start_week (recurring notes plan, Decision 5) ---

def test_staging_source_template_start_week_defaults_to_one(session):
    staging = _staging(session)
    session.refresh(staging)
    assert staging.source_template_start_week == 1


def test_staging_source_template_start_week_round_trip(session):
    template = _template(session)
    config = _config(session)
    staging = RotaStaging(
        config_id=config.id,
        source_template_id=template.id,
        source_template_start_week=3,
    )
    session.add(staging)
    session.flush()
    session.refresh(staging)

    assert staging.source_template_start_week == 3


# --- Reception rota (reception rota plan, Task 1) ---

def _reception_staff(session, code="RA", name="Rita Admin"):
    s = ReceptionStaff(code=code, name=name, active=True)
    session.add(s)
    session.flush()
    return s


def _reception_rota(session, date=datetime.date(2026, 8, 3)):
    rota = ReceptionRota(date=date)
    session.add(rota)
    session.flush()
    return rota


def test_reception_role_round_trips_by_value():
    assert ReceptionRole.PHONES.value == "phones"
    assert ReceptionRole.PRESCRIPTIONS.value == "prescriptions"
    assert ReceptionRole.REGISTRATIONS.value == "registrations"
    assert ReceptionRole.FRONT_DESK.value == "front_desk"
    assert ReceptionRole.ADMIN.value == "admin"
    assert ReceptionRole.ONLINE_TRIAGE.value == "online_triage"
    assert ReceptionRole.ROTAS.value == "rotas"
    assert ReceptionRole.TASKS.value == "tasks"
    assert ReceptionRole.LUNCH.value == "lunch"
    assert ReceptionRole.NOT_WORKING.value == "not_working"
    assert ReceptionRole.OTHER.value == "other"


@pytest.mark.parametrize("bad_hour", [7, 18.5])
def test_reception_master_session_hour_check(session, bad_hour):
    staff = _reception_staff(session)
    session.add(ReceptionMasterSession(
        staff_id=staff.id, day=Day.MONDAY, hour=bad_hour, role=ReceptionRole.PHONES,
    ))
    with pytest.raises(IntegrityError):
        session.flush()


@pytest.mark.parametrize("bad_hour", [7, 18.5])
def test_reception_rota_session_hour_check(session, bad_hour):
    staff = _reception_staff(session)
    rota = _reception_rota(session)
    session.add(ReceptionRotaSession(
        rota_id=rota.id, staff_id=staff.id, hour=bad_hour, role=ReceptionRole.PHONES,
    ))
    with pytest.raises(IntegrityError):
        session.flush()


@pytest.mark.parametrize("bad_hour", [7, 18.5])
def test_reception_coverage_rule_hour_check(session, bad_hour):
    session.add(ReceptionCoverageRule(day=Day.MONDAY, hour=bad_hour, min_phones_staff=2))
    with pytest.raises(IntegrityError):
        session.flush()


def test_reception_master_session_slot_unique(session):
    staff = _reception_staff(session)
    session.add(ReceptionMasterSession(
        staff_id=staff.id, day=Day.MONDAY, hour=9, role=ReceptionRole.PHONES,
    ))
    session.flush()
    session.add(ReceptionMasterSession(
        staff_id=staff.id, day=Day.MONDAY, hour=9, role=ReceptionRole.OTHER,
    ))
    with pytest.raises(IntegrityError):
        session.flush()


def test_reception_rota_session_slot_unique(session):
    staff = _reception_staff(session)
    rota = _reception_rota(session)
    session.add(ReceptionRotaSession(
        rota_id=rota.id, staff_id=staff.id, hour=9, role=ReceptionRole.PHONES,
    ))
    session.flush()
    session.add(ReceptionRotaSession(
        rota_id=rota.id, staff_id=staff.id, hour=9, role=ReceptionRole.OTHER,
    ))
    with pytest.raises(IntegrityError):
        session.flush()


def test_reception_coverage_rule_slot_unique(session):
    session.add(ReceptionCoverageRule(day=Day.MONDAY, hour=9, min_phones_staff=3))
    session.flush()
    session.add(ReceptionCoverageRule(day=Day.MONDAY, hour=9, min_phones_staff=2))
    with pytest.raises(IntegrityError):
        session.flush()


def test_reception_rota_cascades_sessions_on_delete(session):
    staff = _reception_staff(session)
    rota = _reception_rota(session)
    session.add(ReceptionRotaSession(
        rota_id=rota.id, staff_id=staff.id, hour=9, role=ReceptionRole.PHONES,
    ))
    session.flush()

    session.delete(rota)
    session.flush()

    remaining = session.query(ReceptionRotaSession).filter_by(rota_id=rota.id).all()
    assert remaining == []


def test_reception_rota_date_unique(session):
    _reception_rota(session, date=datetime.date(2026, 8, 3))
    session.add(ReceptionRota(date=datetime.date(2026, 8, 3)))
    with pytest.raises(IntegrityError):
        session.flush()


def test_reception_staff_code_unique(session):
    _reception_staff(session, code="RA")
    session.add(ReceptionStaff(code="RA", name="Someone Else"))
    with pytest.raises(IntegrityError):
        session.flush()