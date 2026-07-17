"""API test fixtures: TestClient over a fresh in-memory SQLite DB.

`client` overrides the app's get_db dependency so every request runs against
the test engine (same StaticPool + FK-PRAGMA pattern as the project-level
conftest). `db_session` hands tests a session on the same engine for direct
assertions against rows the API doesn't expose (e.g. snapshot tables).
`seeded` layers base reference data on top: rooms, two doctors with system
counters, and an active master template covering Monday AM/PM.
"""
import datetime

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, event
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app.database import Base
import app.models  # noqa: F401  (registers all models on Base.metadata)
from app.api.deps import get_db
from app.api.main import app
from app.models import (
    Doctor,
    DoctorPreferredRoom,
    MasterRotaSession,
    MasterRotaTemplate,
    Room,
    SystemCounter,
)
from app.models.enums import (
    Day,
    DoctorType,
    MasterSessionType,
    Period,
    RoomType,
    Site,
    SystemCounterType,
)

MONDAY = datetime.date(2026, 1, 5)


@pytest.fixture
def api_engine():
    eng = create_engine(
        "sqlite://",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
        future=True,
    )

    @event.listens_for(eng, "connect")
    def _enable_fk(dbapi_connection, _record):
        cur = dbapi_connection.cursor()
        cur.execute("PRAGMA foreign_keys=ON")
        cur.close()

    Base.metadata.create_all(eng)
    yield eng
    Base.metadata.drop_all(eng)
    eng.dispose()


@pytest.fixture
def session_factory(api_engine):
    return sessionmaker(bind=api_engine, autoflush=False, future=True)


@pytest.fixture
def db_session(session_factory):
    s = session_factory()
    try:
        yield s
    finally:
        s.close()


@pytest.fixture
def client(session_factory):
    def _override_get_db():
        db = session_factory()
        try:
            yield db
        finally:
            db.close()

    app.dependency_overrides[get_db] = _override_get_db
    try:
        with TestClient(app) as c:
            yield c
    finally:
        app.dependency_overrides.pop(get_db, None)


@pytest.fixture
def seeded(client, db_session):
    """Base data: rooms C1/D1, doctors AA/BB (+system counters), an active
    template with REQUIRES_ROOM Monday AM/PM for both doctors. Returns ids.
    """
    s = db_session
    c1 = Room(code="C1", room_type=RoomType.C, site=Site.CUTTESLOWE)
    d1 = Room(code="D1", room_type=RoomType.D, site=Site.SHC)
    aa = Doctor(code="AA", doctor_type=DoctorType.PARTNER, sessions_per_week=10, active=True)
    bb = Doctor(code="BB", doctor_type=DoctorType.SALARIED, sessions_per_week=10, active=True)
    s.add_all([c1, d1, aa, bb])
    s.flush()
    for doc in (aa, bb):
        for ct in (SystemCounterType.ROOM_MOVE, SystemCounterType.SUPERVISION):
            s.add(SystemCounter(doctor_id=doc.id, counter_type=ct, raw_count=0))
    template = MasterRotaTemplate(name="Default", is_active=True)
    s.add(template)
    s.flush()
    for doc in (aa, bb):
        for period in (Period.AM, Period.PM):
            s.add(MasterRotaSession(
                template_id=template.id, doctor_id=doc.id, week=1,
                day=Day.MONDAY, period=period,
                session_type=MasterSessionType.REQUIRES_ROOM,
            ))
    s.commit()
    return {
        "room_c1": c1.id, "room_d1": d1.id,
        "doctor_aa": aa.id, "doctor_bb": bb.id,
        "template": template.id,
    }


@pytest.fixture
def seeded_no_d_rooms(client, db_session):
    """Rooms C1/C2 only (no D rooms), doctors AA (Partner, preference-order-1
    C1) and two trainees TT/UU, all REQUIRES_ROOM Monday AM.

    Exists because Pass 3's SR>D>C>W fallback (phase7_9a.py) means a
    Partner/Salaried doctor with no preference list and any free room
    anywhere no longer stays unresolved after generation -- the `seeded`
    fixture's AA/BB pair can no longer produce a guaranteed-empty room next
    to a guaranteed-free room. Trainees have no such fallback (Pass 3 only
    ever touches Partner/Salaried) and Pass 1/2's D-room-only relocation has
    nothing to work with here, so generation deterministically leaves TT and
    UU unresolved while AA claims C1 via preference, leaving C2 genuinely
    free. Used only by the handful of set-room / swap-rooms tests that need
    exactly that combination; everything else still uses `seeded`.
    """
    s = db_session
    c1 = Room(code="C1", room_type=RoomType.C, site=Site.CUTTESLOWE)
    c2 = Room(code="C2", room_type=RoomType.C, site=Site.CUTTESLOWE)
    aa = Doctor(code="AA", doctor_type=DoctorType.PARTNER, sessions_per_week=10, active=True)
    tt = Doctor(code="TT", doctor_type=DoctorType.TRAINEE, sessions_per_week=10, active=True)
    uu = Doctor(code="UU", doctor_type=DoctorType.TRAINEE, sessions_per_week=10, active=True)
    s.add_all([c1, c2, aa, tt, uu])
    s.flush()
    for doc in (aa, tt, uu):
        for ct in (SystemCounterType.ROOM_MOVE, SystemCounterType.SUPERVISION):
            s.add(SystemCounter(doctor_id=doc.id, counter_type=ct, raw_count=0))
    s.add(DoctorPreferredRoom(doctor_id=aa.id, preference_order=1, room_id=c1.id))
    template = MasterRotaTemplate(name="Default", is_active=True)
    s.add(template)
    s.flush()
    for doc in (aa, tt, uu):
        s.add(MasterRotaSession(
            template_id=template.id, doctor_id=doc.id, week=1,
            day=Day.MONDAY, period=Period.AM,
            session_type=MasterSessionType.REQUIRES_ROOM,
        ))
    s.commit()
    return {
        "room_c1": c1.id, "room_c2": c2.id,
        "doctor_aa": aa.id, "doctor_tt": tt.id, "doctor_uu": uu.id,
        "template": template.id,
    }


def make_clinic_type_via_api(client, seeded, name="Dragon"):
    """POST a clinic type scheduled Monday AM, AA-eligible, C1-eligible.

    clinic_priority is server-managed and not part of the request body --
    the created row is appended at the end of the enabled sequence.
    """
    resp = client.post("/api/v1/clinic-types", json={
        "name": name,
        "room_required": True,
        "schedules": [{"day": "Monday", "period": "AM"}],
        "doctor_eligibilities": [{"doctor_id": seeded["doctor_aa"], "doctor_priority": 1}],
        "room_eligibilities": [{"room_id": seeded["room_c1"]}],
    })
    assert resp.status_code == 201, resp.text
    return resp.json()


def generate_rota(client, num_weeks=1, start_date=MONDAY):
    resp = client.post("/api/v1/rota/generate", json={
        "start_date": start_date.isoformat(),
        "num_weeks": num_weeks,
        "template_start_week": 1,
    })
    assert resp.status_code == 200, resp.text
    return resp.json()