"""add extra_session_entries (extra sessions plan, Task 1)

Revision ID: 014
Revises: 013
Create Date: 2026-07-22 00:00:00

Additive only, no backfill - new feature, table starts empty.

extra_session_entries mirrors leave_entries exactly: doctor_id, date,
period, unique on the triple. No new enum type is introduced -- the
period column reuses the existing Postgres enum type created by 001
(period), create_type=False, copying migration 011's _enum_column
pattern.

downgrade() is a real drop_table. Unlike migration 011, this table does
not share ownership of the period enum type with any other table being
dropped in the same downgrade step, so nothing else needs protecting
here.
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

from app.models.enums import Period, _snake

revision: str = "014"
down_revision: Union[str, None] = "013"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def _enum_column(name: str, py_enum, nullable: bool) -> sa.Column:
    """Mirrors migration 011's _enum_column(): on Postgres, references the
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
        "extra_session_entries",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column(
            "doctor_id", sa.Integer(), sa.ForeignKey("doctors.id"), nullable=False
        ),
        sa.Column("date", sa.Date(), nullable=False),
        _enum_column("period", Period, nullable=False),
        sa.UniqueConstraint(
            "doctor_id", "date", "period", name="uq_extra_session_slot"
        ),
    )


def downgrade() -> None:
    op.drop_table("extra_session_entries")