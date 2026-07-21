"""add Doctor.supervision_preference (Phase 9C preference weighting)

Revision ID: 012
Revises: 011
Create Date: 2026-07-21 00:00:00

Additive only. `doctors` already has rows in any deployed environment, so
this needs a server_default at add-column time, same reasoning as
migration 003's `is_supervising`: existing doctors default to "normal"
(1x multiplier), which is the correct reading -- nobody's supervision
weighting changes until someone deliberately edits it.

This is a new native enum type, not a reuse of an existing one, so unlike
002/011 (which reference already-created types via create_type=False) this
is the first add-column migration since 001 that must also create the
Postgres type itself. Mirrors 001's explicit
`postgresql.ENUM(...).create(bind, checkfirst=True)` pattern in upgrade(),
with a matching `.drop(bind, checkfirst=True)` in downgrade() after the
column is dropped. Safe to drop unconditionally on downgrade: no other
table references this type.
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

from app.models.enums import SupervisionPreference, _snake

revision: str = "012"
down_revision: Union[str, None] = "011"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

_TYPE_NAME = _snake(SupervisionPreference.__name__)
_VALUES = [member.value for member in SupervisionPreference]


def _enum_column() -> sa.Column:
    if op.get_bind().dialect.name == "postgresql":
        enum_type = postgresql.ENUM(
            SupervisionPreference, name=_TYPE_NAME, create_type=False,
            values_callable=lambda e: _VALUES,
        )
    else:
        enum_type = sa.Enum(
            SupervisionPreference, name=_TYPE_NAME, values_callable=lambda e: _VALUES,
        )
    return sa.Column(
        "supervision_preference", enum_type, nullable=False, server_default="normal",
    )


def upgrade() -> None:
    bind = op.get_bind()
    if bind.dialect.name == "postgresql":
        postgresql.ENUM(
            SupervisionPreference, name=_TYPE_NAME, values_callable=lambda e: _VALUES,
        ).create(bind, checkfirst=True)

    op.add_column("doctors", _enum_column())


def downgrade() -> None:
    op.drop_column("doctors", "supervision_preference")

    bind = op.get_bind()
    if bind.dialect.name == "postgresql":
        postgresql.ENUM(
            SupervisionPreference, name=_TYPE_NAME, values_callable=lambda e: _VALUES,
        ).drop(bind, checkfirst=True)