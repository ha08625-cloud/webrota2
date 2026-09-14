"""wfh counter type, wfh_preference column, preference_weight enum rename

Revision ID: 015
Revises: 014
Create Date: 2026-09-14 00:00:00

WFH counter plan, Task 1. Three pieces of DDL and deliberately no DML:

1. `supervision_preference` -> `preference_weight`. The Python enum is now
   shared by two columns (`doctors.supervision_preference` and the new
   `doctors.wfh_preference`), so the type name no longer names one of them
   (plan D5). Migration 001 freezes its own copy of the old class so that the
   baseline still creates `supervision_preference` for this to rename.
2. `system_counter_type` gains `wfh` (plan D1): one ledger of "sessions this
   doctor spent working at home", which the future WFH allocation phase
   selects against.
3. `doctors.wfh_preference`, NOT NULL, server default `normal` -- the twin of
   `supervision_preference`, carried by every doctor row regardless of
   doctor_type (plan D8).

**No rows are inserted here.** Every doctor needs a `wfh` SystemCounter row
(the invariant `generate._write_counters` enforces with `.scalar_one()`), but
Postgres forbids *using* an enum value in the same transaction that added it,
and alembic/env.py wraps the whole upgrade in a single
`context.begin_transaction()` -- so a later migration in the same run would
fail too. The rows are created instead by the existing, idempotent
`seed/backfill_system_counters.py`, which iterates SystemCounterType and is
already documented as the repair for missing counter rows. Run it as a deploy
step after `alembic upgrade head`:

    DATABASE_URL=<railway url> uv run python -m seed.backfill_system_counters

Only Postgres needs the enum work: SQLite renders every enum as VARCHAR +
CHECK built fresh from the Python enum at `create_all` time, and the test
suite builds SQLite that way rather than by migrating. The column add runs on
both.

Downgrade drops the column, renames the type back, and rebuilds
`system_counter_type` without `wfh` (Postgres has no `DROP VALUE`) via the
rename/recreate/swap dance migration 004 uses. That last step fails if any
row still uses `wfh`, which is the accepted behaviour for narrowing an enum.
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

from app.models.enums import PreferenceWeight

revision: str = "015"
down_revision: Union[str, None] = "014"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

# system_counter_type as it stood before this migration, for the downgrade's
# recreate step, and the tables whose columns use it.
_OLD_COUNTER_TYPES = ["room_move", "supervision"]
_COUNTER_TYPE_TABLES = ["system_counters", "rota_system_counter_snapshots"]


def _values(py_enum):
    return [member.value for member in py_enum]


def _preference_weight_col_type():
    """Column type for `wfh_preference`.

    On Postgres the `preference_weight` type already exists (renamed just
    above), so `create_type=False` keeps ADD COLUMN from trying to create it
    again. On SQLite this renders VARCHAR + CHECK.
    """
    if op.get_bind().dialect.name == "postgresql":
        return postgresql.ENUM(
            PreferenceWeight,
            name="preference_weight",
            create_type=False,
            values_callable=_values,
        )
    return sa.Enum(PreferenceWeight, name="preference_weight", values_callable=_values)


def upgrade() -> None:
    if op.get_bind().dialect.name == "postgresql":
        op.execute("ALTER TYPE supervision_preference RENAME TO preference_weight")
        op.execute("ALTER TYPE system_counter_type ADD VALUE IF NOT EXISTS 'wfh'")

    op.add_column(
        "doctors",
        sa.Column(
            "wfh_preference",
            _preference_weight_col_type(),
            server_default="normal",
            nullable=False,
        ),
    )


def downgrade() -> None:
    op.drop_column("doctors", "wfh_preference")

    if op.get_bind().dialect.name != "postgresql":
        return

    op.execute("ALTER TYPE preference_weight RENAME TO supervision_preference")

    op.execute("ALTER TYPE system_counter_type RENAME TO system_counter_type_old")
    values_sql = ", ".join(f"'{v}'" for v in _OLD_COUNTER_TYPES)
    op.execute(f"CREATE TYPE system_counter_type AS ENUM ({values_sql})")
    for table in _COUNTER_TYPE_TABLES:
        op.execute(
            f"ALTER TABLE {table} ALTER COLUMN counter_type TYPE system_counter_type "
            f"USING counter_type::text::system_counter_type"
        )
    op.execute("DROP TYPE system_counter_type_old")
