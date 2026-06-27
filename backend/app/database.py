"""Engine, session factory, and declarative Base.

DATABASE_URL defaults to a local SQLite file for development. Setting the
DATABASE_URL environment variable (e.g. to a Postgres URL on Railway) switches
the engine with no code changes.
"""
import os

from sqlalchemy import create_engine
from sqlalchemy.orm import DeclarativeBase, sessionmaker

DATABASE_URL = os.environ.get("DATABASE_URL", "sqlite:///./rota.db")

# SQLite needs check_same_thread disabled for use across threads (e.g. FastAPI).
_connect_args = {"check_same_thread": False} if DATABASE_URL.startswith("sqlite") else {}

engine = create_engine(DATABASE_URL, connect_args=_connect_args, future=True)

SessionLocal = sessionmaker(bind=engine, autoflush=False, autocommit=False, future=True)


class Base(DeclarativeBase):
    """Declarative base for all ORM models."""
    pass
