"""add blocked_entries and notes columns (clinical rota, Blocked planner option)

Revision ID: 023
Revises: 022
Create Date: 2026-07-30 00:00:00

Adds `blocked_entries` (mirrors leave_entries/extra_session_entries: doctor_id,
date, period, unique on the triple), plus a nullable `notes` column (12-char
cap) on all three tables backing the Annual Planner grid. Additive only, no
backfill -- the system is not yet live, and null notes is the correct
reading of every existing row.
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

from app.models.blocked import NOTES_MAX_LENGTH
from app.models.enums import Period, _snake

revision: str = "023"
down_revision: Union[str, None] = "022"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def _enum_column(name: str, py_enum, nullable: bool) -> sa.Column:
    """Mirrors migration 014's _enum_column(): on Postgres, references the
    existing named enum type without recreating it; elsewhere (SQLite), a
    plain sa.Enum (renders VARCHAR + CHECK)."""
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
        "blocked_entries",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column(
            "doctor_id", sa.Integer(), sa.ForeignKey("doctors.id"), nullable=False
        ),
        sa.Column("date", sa.Date(), nullable=False),
        _enum_column("period", Period, nullable=False),
        sa.Column("notes", sa.String(NOTES_MAX_LENGTH), nullable=True),
        sa.UniqueConstraint("doctor_id", "date", "period", name="uq_blocked_slot"),
    )
    op.add_column(
        "leave_entries", sa.Column("notes", sa.String(NOTES_MAX_LENGTH), nullable=True)
    )
    op.add_column(
        "extra_session_entries",
        sa.Column("notes", sa.String(NOTES_MAX_LENGTH), nullable=True),
    )


def downgrade() -> None:
    op.drop_column("extra_session_entries", "notes")
    op.drop_column("leave_entries", "notes")
    op.drop_table("blocked_entries")
