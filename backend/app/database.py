"""Engine, session factory, and declarative Base.

DATABASE_URL defaults to a local SQLite file for development. Setting the
DATABASE_URL environment variable (e.g. to a Postgres URL on Railway) switches
the engine with no code changes.
"""
import os

from sqlalchemy import MetaData, create_engine
from sqlalchemy.orm import DeclarativeBase, sessionmaker

DATABASE_URL = os.environ.get("DATABASE_URL", "sqlite:///./rota.db")

# SQLite needs check_same_thread disabled for use across threads (e.g. FastAPI).
_connect_args = {"check_same_thread": False} if DATABASE_URL.startswith("sqlite") else {}

engine = create_engine(DATABASE_URL, connect_args=_connect_args, future=True)

SessionLocal = sessionmaker(bind=engine, autoflush=False, autocommit=False, future=True)


# Names the constraints that models declare without one, so that the schema
# create_all() builds and the schema the Alembic baseline builds agree. Only
# `uq` needs a rule: eight columns use the `unique=True` shorthand, which
# leaves the constraint anonymous and lets the backend invent a name
# (Postgres would pick `doctors_code_key`), whereas every migration has
# always spelled these out as `uq_doctors_code`. Every other constraint kind
# is either named explicitly at the model (check constraints, multi-column
# uniques) or deliberately left to the backend default (`*_pkey`, `*_fkey`),
# so adding rules for them would rename existing objects for no gain. `ix` is
# SQLAlchemy's own default, repeated here because supplying a convention
# replaces the default dict rather than merging into it.
NAMING_CONVENTION = {
    "ix": "ix_%(column_0_label)s",
    "uq": "uq_%(table_name)s_%(column_0_name)s",
}


class Base(DeclarativeBase):
    """Declarative base for all ORM models."""

    metadata = MetaData(naming_convention=NAMING_CONVENTION)
