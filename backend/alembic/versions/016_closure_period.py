"""add period to practice_closures and rota_closures (half-day closures)

Revision ID: 016
Revises: 015
Create Date: 2026-07-28 00:00:00

Half-day practice closures (Task 1): PracticeClosure and RotaClosure each
gain a non-nullable `period` column, mirroring LeaveEntry's half-day
granularity. A full-day closure becomes two rows for the same date, one per
period -- there is no in-place backfill that preserves meaning for existing
rows, since a single legacy row cannot be split into "AM" and "PM" without
guessing which the closure actually meant. The system is not live, so
upgrade() deletes all existing rows in both tables before adding the column
non-nullable with no server default; this is a deliberate choice for a
not-yet-live system, not an oversight. downgrade() mirrors it: two half rows
cannot collapse back into one, so it also deletes all rows before dropping
the column and restoring the original constraints.

The `period` column reuses the existing Postgres enum type created by 001
(create_type=False), via the same `_enum_column` helper migrations 011, 014
and 015 use, copied verbatim here. Note that 004 (the original closures
migration) is not the right reference despite being the closures migration --
its docstring explicitly says "No enums involved, so none of 001/002's
enum-type-reuse handling applies", which no longer holds once `period` is
added.

Both constraint changes (dropping uq_practice_closures_date /
uq_rota_closure_date, adding the (date, period) / (rota_id, date, period)
replacements) go through `op.batch_alter_table`, since dev runs SQLite
(database.py:12 defaults to sqlite:///./rota.db), which cannot alter or drop
a constraint in place. This is the first migration in the project to drop a
constraint, so there is no local precedent to copy.
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

from app.models.enums import Period, _snake

revision: str = "016"
down_revision: Union[str, None] = "015"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def _enum_column(name: str, py_enum, nullable: bool) -> sa.Column:
    """Copied verbatim from migration 015 (which copied 014, which copied
    011): on Postgres, references the existing named enum type without
    recreating it; elsewhere (SQLite), a plain sa.Enum (renders VARCHAR +
    CHECK)."""
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
    op.execute("DELETE FROM rota_closures")
    op.execute("DELETE FROM practice_closures")

    with op.batch_alter_table("practice_closures") as batch_op:
        batch_op.drop_constraint("uq_practice_closures_date", type_="unique")
        batch_op.add_column(_enum_column("period", Period, nullable=False))
        batch_op.create_unique_constraint(
            "uq_practice_closure_slot", ["date", "period"]
        )

    with op.batch_alter_table("rota_closures") as batch_op:
        batch_op.drop_constraint("uq_rota_closure_date", type_="unique")
        batch_op.add_column(_enum_column("period", Period, nullable=False))
        batch_op.create_unique_constraint(
            "uq_rota_closure_slot", ["rota_id", "date", "period"]
        )


def downgrade() -> None:
    op.execute("DELETE FROM rota_closures")
    op.execute("DELETE FROM practice_closures")

    with op.batch_alter_table("rota_closures") as batch_op:
        batch_op.drop_constraint("uq_rota_closure_slot", type_="unique")
        batch_op.drop_column("period")
        batch_op.create_unique_constraint(
            "uq_rota_closure_date", ["rota_id", "date"]
        )

    with op.batch_alter_table("practice_closures") as batch_op:
        batch_op.drop_constraint("uq_practice_closure_slot", type_="unique")
        batch_op.drop_column("period")
        batch_op.create_unique_constraint(
            "uq_practice_closures_date", ["date"]
        )
