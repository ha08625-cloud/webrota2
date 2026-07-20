"""add rota_stagings, rota_staging_sessions (staging plan, Task 1)

Revision ID: 011
Revises: 010
Create Date: 2026-07-20 00:00:00

Additive only, no backfill - both tables start empty. This is a new
feature with no prior data to migrate.

rota_stagings: header row. config_id is unique (one staging per
RotaConfig); source_template_id points at the MasterRotaTemplate the
staging was copied from. completed_at is nullable - null means active,
set means completed (see the model docstring for the full lifecycle
rationale).

rota_staging_sessions: mirrors master_rota_sessions, with staging_id in
place of template_id. The day/period/session_type columns reuse the
existing Postgres enum types created by 001 (day, period,
master_session_type) - create_type=False, copying migration 002's
pattern exactly. downgrade() must NOT drop these enum types:
clinic_type_schedules, rota_generation_log_entries, master_rota_sessions,
and rota_sessions all still depend on them.
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

from app.models.enums import Day, MasterSessionType, Period, _snake

revision: str = "011"
down_revision: Union[str, None] = "010"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def _enum_column(name: str, py_enum, nullable: bool) -> sa.Column:
    """Mirrors migration 002's _template_type_column() helper: on
    Postgres, references the existing named enum type without recreating
    it; elsewhere (SQLite), a plain sa.Enum (renders VARCHAR + CHECK)."""
    type_name = _snake(py_enum.__name__)
    values = [member.value for member in py_enum]
    if op.get_bind().dialect.name == "postgresql":
        enum_type = postgresql.ENUM(
            py_enum, name=type_name, create_type=False, values_callable=lambda e: values,
        )
    else:
        enum_type = sa.Enum(py_enum, name=type_name, values_callable=lambda e: values)
    return sa.Column(name, enum_type, nullable=nullable)


def upgrade() -> None:
    op.create_table(
        "rota_stagings",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column(
            "config_id", sa.Integer(),
            sa.ForeignKey("rota_configs.id"), nullable=False,
        ),
        sa.Column(
            "source_template_id", sa.Integer(),
            sa.ForeignKey("master_rota_templates.id"), nullable=False,
        ),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("completed_at", sa.DateTime(timezone=True), nullable=True),
        sa.UniqueConstraint("config_id", name="uq_rota_stagings_config_id"),
    )

    op.create_table(
        "rota_staging_sessions",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column(
            "staging_id", sa.Integer(),
            sa.ForeignKey("rota_stagings.id"), nullable=False,
        ),
        sa.Column(
            "doctor_id", sa.Integer(),
            sa.ForeignKey("doctors.id"), nullable=False,
        ),
        sa.Column("week", sa.Integer(), nullable=False),
        _enum_column("day", Day, nullable=False),
        _enum_column("period", Period, nullable=False),
        _enum_column("session_type", MasterSessionType, nullable=False),
        sa.Column(
            "room_id", sa.Integer(),
            sa.ForeignKey("rooms.id"), nullable=True,
        ),
        sa.CheckConstraint("week BETWEEN 1 AND 4", name="ck_rss_week"),
        sa.UniqueConstraint(
            "staging_id", "doctor_id", "week", "day", "period", name="uq_rss_slot"
        ),
    )


def downgrade() -> None:
    # Tables only - day, period, and master_session_type enum types are
    # still used by clinic_type_schedules, rota_generation_log_entries,
    # master_rota_sessions, and rota_sessions, and must not be dropped
    # here.
    op.drop_table("rota_staging_sessions")
    op.drop_table("rota_stagings")