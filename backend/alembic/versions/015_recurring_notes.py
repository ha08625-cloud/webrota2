"""add recurring notes + rota_stagings.source_template_start_week

Revision ID: 015
Revises: 014
Create Date: 2026-07-24 00:00:00

Additive only, no backfill for the three new tables - new feature, they
start empty.

The `day` and `period` columns reuse the existing Postgres enum types
created by 001 (create_type=False), via the same `_enum_column` helper
migrations 011 and 014 use. downgrade() therefore drops no enum type:
both are shared with clinic_type_schedules, master_rota_sessions,
rota_staging_sessions, rota_sessions and rota_generation_log, all of
which survive.

`rota_stagings.source_template_start_week` needs a server_default because
the table may already hold rows. Defaulting existing stagings to 1 is the
correct reading, not just a type-safety formality: 1 is exactly what
`RotaConfig.template_start_week` is normalised to on a staged run today,
so a pre-existing staging keeps behaving as it did before this migration.

Table creation order is parent-then-child (recurring_notes first), and
downgrade() reverses it, mirroring the FK direction the way 004 does --
even though cascade in this schema is ORM-level, never DB-level.
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

from app.models.enums import Day, Period, _snake

revision: str = "015"
down_revision: Union[str, None] = "014"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def _enum_column(name: str, py_enum, nullable: bool) -> sa.Column:
    """Copied verbatim from migration 014 (which copied 011): on Postgres,
    references the existing named enum type without recreating it;
    elsewhere (SQLite), a plain sa.Enum (renders VARCHAR + CHECK)."""
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
        "recurring_notes",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("text", sa.String(length=200), nullable=False),
        _enum_column("day", Day, nullable=False),
        _enum_column("period", Period, nullable=False),
        sa.Column(
            "is_active", sa.Boolean(), nullable=False, server_default=sa.true()
        ),
    )

    op.create_table(
        "recurring_note_doctors",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column(
            "note_id",
            sa.Integer(),
            sa.ForeignKey("recurring_notes.id"),
            nullable=False,
        ),
        sa.Column(
            "doctor_id", sa.Integer(), sa.ForeignKey("doctors.id"), nullable=False
        ),
        sa.UniqueConstraint("note_id", "doctor_id", name="uq_rnd_note_doctor"),
    )

    op.create_table(
        "recurring_note_weeks",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column(
            "note_id",
            sa.Integer(),
            sa.ForeignKey("recurring_notes.id"),
            nullable=False,
        ),
        sa.Column("template_week", sa.Integer(), nullable=False),
        sa.CheckConstraint("template_week BETWEEN 1 AND 4", name="ck_rnw_week"),
        sa.UniqueConstraint("note_id", "template_week", name="uq_rnw_note_week"),
    )

    op.add_column(
        "rota_stagings",
        sa.Column(
            "source_template_start_week",
            sa.Integer(),
            nullable=False,
            server_default="1",
        ),
    )


def downgrade() -> None:
    op.drop_column("rota_stagings", "source_template_start_week")
    op.drop_table("recurring_note_weeks")
    op.drop_table("recurring_note_doctors")
    op.drop_table("recurring_notes")