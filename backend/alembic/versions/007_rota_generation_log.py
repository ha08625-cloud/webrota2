"""add rota_generation_log table (generation decision log, Task 1)

Revision ID: 007
Revises: 006
Create Date: 2026-07-15 00:00:00

New table only, no changes to existing tables. Reuses the `day` and
`period` Postgres enum types created by 001 for the `day`/`period`
columns -- create_type=False, following 002's reuse pattern -- since
those types already exist on Postgres. downgrade() drops only this
table; it must not drop the shared enum types, which
master_rota_sessions/rota_sessions/etc. still depend on.

Entity-reference columns (doctor_id, related_doctor_id, room_id,
related_room_id, clinic_type_id) are plain nullable integers with no FK
constraints -- see the RotaGenerationLogEntry model docstring for why.
Only rota_id is a real FK, with the standard cascade-on-delete-of-rota
behaviour implemented at the ORM relationship level
(cascade="all, delete-orphan" on GeneratedRota.generation_log).
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

from app.models.enums import Day, Period, _snake

revision: str = "007"
down_revision: Union[str, None] = "006"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def _enum(py_enum) -> sa.types.TypeEngine:
    """Mirrors 001's _enum()/002's _template_type_column() pattern: on
    Postgres, references an existing enum type without recreating it;
    elsewhere (SQLite), a plain sa.Enum (renders VARCHAR + CHECK)."""
    name = _snake(py_enum.__name__)
    values = [member.value for member in py_enum]
    if op.get_bind().dialect.name == "postgresql":
        return postgresql.ENUM(
            py_enum, name=name, create_type=False, values_callable=lambda e: values,
        )
    return sa.Enum(py_enum, name=name, values_callable=lambda e: values)


def upgrade() -> None:
    op.create_table(
        "rota_generation_log",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column(
            "rota_id", sa.Integer(),
            sa.ForeignKey("generated_rotas.id"), nullable=False,
        ),
        sa.Column("sequence", sa.Integer(), nullable=False),
        sa.Column("phase", sa.String(20), nullable=False),
        sa.Column("action", sa.String(40), nullable=False),
        sa.Column("week", sa.Integer(), nullable=True),
        sa.Column("day", _enum(Day), nullable=True),
        sa.Column("period", _enum(Period), nullable=True),
        sa.Column("doctor_id", sa.Integer(), nullable=True),
        sa.Column("related_doctor_id", sa.Integer(), nullable=True),
        sa.Column("room_id", sa.Integer(), nullable=True),
        sa.Column("related_room_id", sa.Integer(), nullable=True),
        sa.Column("clinic_type_id", sa.Integer(), nullable=True),
        sa.Column("message", sa.Text(), nullable=False),
        sa.UniqueConstraint("rota_id", "sequence", name="uq_rota_log_sequence"),
    )
    op.create_index(
        "ix_rota_generation_log_rota_id", "rota_generation_log", ["rota_id"],
    )


def downgrade() -> None:
    # Table only -- day/period enum types are still used by
    # master_rota_sessions, rota_sessions, clinic_type_schedules, and
    # leave_entries, so they must not be dropped here.
    op.drop_index("ix_rota_generation_log_rota_id", table_name="rota_generation_log")
    op.drop_table("rota_generation_log")