"""add User.access_level (role-based auth plan, Task 1)

Revision ID: 028
Revises: 027
Create Date: 2026-08-11 00:00:00

Additive only. `users` has rows in every deployed environment, so a
non-nullable column needs a server_default at add-column time -- same
reasoning as migrations 003 and 012.

The default is "nurse", the *lowest* tier, not "manager" (role-based auth
plan, Design Decision 7). Backfilling every existing user as a manager
would be a silent security hole that nothing in the app makes visible; an
accidental viewer, by contrast, announces itself the first time someone
tries to write and is fixed with one PATCH. The bootstrap manager comes
from re-running seed/seed_users.py, which sets access_level explicitly.

The server_default stays in place after the backfill rather than being
dropped: it costs nothing and means a direct INSERT (a script, a manual
psql session) cannot produce a null on a NOT NULL column.

This is a new native enum type, so upgrade() creates the Postgres type
explicitly before add_column -- the same postgresql.ENUM(...).create(bind,
checkfirst=True) / .drop(bind, checkfirst=True) pattern as 012, since
add_column alone will not emit CREATE TYPE. SQLite renders VARCHAR + CHECK
and needs neither call.
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

from app.models.enums import AccessLevel, _snake

revision: str = "028"
down_revision: Union[str, None] = "027"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

_TYPE_NAME = _snake(AccessLevel.__name__)
_VALUES = [member.value for member in AccessLevel]


def _enum_column() -> sa.Column:
    if op.get_bind().dialect.name == "postgresql":
        enum_type = postgresql.ENUM(
            AccessLevel, name=_TYPE_NAME, create_type=False,
            values_callable=lambda e: _VALUES,
        )
    else:
        enum_type = sa.Enum(
            AccessLevel, name=_TYPE_NAME, values_callable=lambda e: _VALUES,
        )
    return sa.Column(
        "access_level", enum_type, nullable=False,
        server_default=AccessLevel.NURSE.value,
    )


def upgrade() -> None:
    bind = op.get_bind()
    if bind.dialect.name == "postgresql":
        postgresql.ENUM(
            AccessLevel, name=_TYPE_NAME, values_callable=lambda e: _VALUES,
        ).create(bind, checkfirst=True)

    op.add_column("users", _enum_column())


def downgrade() -> None:
    op.drop_column("users", "access_level")

    bind = op.get_bind()
    if bind.dialect.name == "postgresql":
        postgresql.ENUM(
            AccessLevel, name=_TYPE_NAME, values_callable=lambda e: _VALUES,
        ).drop(bind, checkfirst=True)
