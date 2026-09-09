"""recurring_note_instances

Revision ID: 012
Revises: 011
Create Date: 2026-09-08 00:00:00

Splits recurring notes into a *definition* library and *per-run instances*.

`recurring_notes` (with `recurring_note_doctors`) stops scheduling anything
and becomes a library of named meetings whose day, period and doctor list
are defaults. The two new tables hold what the engine actually reads:
`rota_config_notes` is one note for one run and one *generation* week, and
`rota_config_note_doctors` is the doctor list copied onto it at pick time.
`source_note_id` is provenance only, nullable both because a free-form
one-off note has no definition behind it and because deleting a definition
nulls the column rather than removing instances already picked.

`recurring_note_weeks` is dropped outright. It anchored a note to *template*
weeks so a fortnightly note landed on the same real-world fortnight every
run; in practice meetings move constantly for leave and other commitments,
so the stamp was wrong more often than right and the weeks are now picked
per run instead. There is no backfill in either direction and none is
possible: a template week is not a generation week of any particular run,
and the system is not live, so there is no data worth migrating.

The `week` check bounds the column to 1-4, the range the schema allows
anywhere; the router bounds it again against the run's own `num_weeks`,
since a week-3 note on a 2-week run is silently dead. `config_id` is
indexed because the engine's only query filters on it. Cascades stay
ORM-level, as everywhere else in this schema -- no ON DELETE is introduced
here.

Only Postgres needs this migration -- CI runs `alembic upgrade head` /
`downgrade base` against it, while the test suite builds SQLite straight
from the models via `create_all`.

Downgrade drops the two new tables (losing every picked note, which is
run-scoped draft state) and recreates `recurring_note_weeks` empty, with
its original check and unique constraints. Every definition then applies to
no weeks at all, so the pre-012 engine stamps nothing until the weeks are
re-entered by hand -- the safe direction for a purely additive annotation.
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

from app.models.enums import Day, Period, _snake

revision: str = "012"
down_revision: Union[str, None] = "011"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def _enum(py_enum):
    """Column type for a Python enum, matching 001's helper.

    On Postgres the named types already exist (created once in 001), so the
    column must reference them without re-emitting CREATE TYPE.
    """
    name = _snake(py_enum.__name__)
    values = lambda e: [m.value for m in e]  # noqa: E731
    if op.get_bind().dialect.name == "postgresql":
        return postgresql.ENUM(py_enum, name=name, create_type=False, values_callable=values)
    return sa.Enum(py_enum, name=name, values_callable=values)


def upgrade() -> None:
    op.create_table(
        "rota_config_notes",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column(
            "config_id", sa.Integer(), sa.ForeignKey("rota_configs.id"), nullable=False
        ),
        sa.Column(
            "source_note_id",
            sa.Integer(),
            sa.ForeignKey("recurring_notes.id"),
            nullable=True,
        ),
        sa.Column("text", sa.String(length=200), nullable=False),
        sa.Column("week", sa.Integer(), nullable=False),
        sa.Column("day", _enum(Day), nullable=False),
        sa.Column("period", _enum(Period), nullable=False),
        sa.CheckConstraint("week BETWEEN 1 AND 4", name="ck_rcn_week"),
    )
    op.create_index("ix_rota_config_notes_config_id", "rota_config_notes", ["config_id"])

    op.create_table(
        "rota_config_note_doctors",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column(
            "config_note_id",
            sa.Integer(),
            sa.ForeignKey("rota_config_notes.id"),
            nullable=False,
        ),
        sa.Column(
            "doctor_id", sa.Integer(), sa.ForeignKey("doctors.id"), nullable=False
        ),
        sa.UniqueConstraint("config_note_id", "doctor_id", name="uq_rcnd_note_doctor"),
    )

    op.drop_table("recurring_note_weeks")


def downgrade() -> None:
    op.create_table(
        "recurring_note_weeks",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column(
            "note_id", sa.Integer(), sa.ForeignKey("recurring_notes.id"), nullable=False
        ),
        sa.Column("template_week", sa.Integer(), nullable=False),
        sa.CheckConstraint("template_week BETWEEN 1 AND 4", name="ck_rnw_week"),
        sa.UniqueConstraint("note_id", "template_week", name="uq_rnw_note_week"),
    )

    op.drop_table("rota_config_note_doctors")
    op.drop_index("ix_rota_config_notes_config_id", table_name="rota_config_notes")
    op.drop_table("rota_config_notes")
