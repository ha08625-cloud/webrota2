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


def make_clinic_type_via_api(client, seeded, name="Dragon"):
    """POST a clinic type scheduled Monday AM, AA-eligible, C1-eligible."""
    resp = client.post("/api/v1/clinic-types", json={
        "name": name,
        "clinic_priority": 10,
        "room_required": True,
        "schedules": [{"day": "Monday", "period": "AM"}],
        "doctor_eligibilities": [{"doctor_id": seeded["doctor_aa"], "doctor_priority": 1}],
        "room_eligibilities": [{"room_id": seeded["room_c1"]}],
    })
    assert resp.status_code == 201, resp.text
    return resp.json()


def generate_rota(client, num_weeks=1):
    resp = client.post("/api/v1/rota/generate", json={
        "start_date": MONDAY.isoformat(),
        "num_weeks": num_weeks,
        "template_start_week": 1,
    })
    assert resp.status_code == 200, resp.text
    return resp.json()