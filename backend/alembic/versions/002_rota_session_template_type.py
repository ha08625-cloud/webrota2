"""add RotaSession.template_type (M3.6)

Revision ID: 002
Revises: 001
Create Date: 2026-07-07 00:00:00

Adds a single nullable column. No data migration - the system is
pre-production, and null already has a defined meaning (renders as a
normal session in the API and frontend), so there is nothing to backfill.

Reuses the master_session_type Postgres enum type created by 001 for
MasterRotaSession.session_type - create_type=False, and critically,
downgrade() must NOT drop that type, since master_rota_sessions still
depends on it.
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

from app.models.enums import MasterSessionType, _snake

revision: str = "002"
down_revision: Union[str, None] = "001"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def _template_type_column() -> sa.Column:
    """Mirrors 001's _enum() helper for this one column: on Postgres,
    references the existing master_session_type type without recreating
    it; elsewhere (SQLite), a plain sa.Enum (renders VARCHAR + CHECK)."""
    name = _snake(MasterSessionType.__name__)
    values = [member.value for member in MasterSessionType]
    if op.get_bind().dialect.name == "postgresql":
        enum_type = postgresql.ENUM(
            MasterSessionType, name=name, create_type=False, values_callable=lambda e: values,
        )
    else:
        enum_type = sa.Enum(MasterSessionType, name=name, values_callable=lambda e: values)
    return sa.Column("template_type", enum_type, nullable=True)


def upgrade() -> None:
    op.add_column("rota_sessions", _template_type_column())


def downgrade() -> None:
    # Column only - master_rota_sessions.session_type still uses the
    # master_session_type enum type, so it must not be dropped here.
    op.drop_column("rota_sessions", "template_type")