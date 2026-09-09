"""Shared pytest fixtures: an in-memory SQLite DB with all tables created.

Uses StaticPool so the single in-memory connection persists for the test, and
enables SQLite FK enforcement (off by default) so FK-dependent behaviour is
realistic.

`_disable_audit_writes` is the project-wide safety net for the audit
middleware. Importing app.api.main points the audit session factory at
SessionLocal, i.e. the developer's real ./rota.db -- and the middleware runs
on every non-GET request in the whole API suite. The autouse fixture below
disables the write for every test everywhere, so no test can put audit rows
into a real database by accident. tests/test_api/conftest.py re-enables it
against the per-test engine; see the ordering note there.
"""
import pytest
from sqlalchemy import create_engine, event
from sqlalchemy.orm import Session, sessionmaker
from sqlalchemy.pool import StaticPool

from app.database import Base
import app.models  # noqa: F401  (registers all models on Base.metadata)


@pytest.fixture(autouse=True)
def _disable_audit_writes():
    """Disable audit-log writes for every test in the suite by default."""
    from app.api.audit import get_session_factory, set_session_factory

    previous = get_session_factory()
    set_session_factory(None)
    try:
        yield
    finally:
        set_session_factory(previous)


@pytest.fixture
def engine():
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
def session(engine) -> Session:
    factory = sessionmaker(bind=engine, autoflush=False, future=True)
    s = factory()
    try:
        yield s
    finally:
        s.close()