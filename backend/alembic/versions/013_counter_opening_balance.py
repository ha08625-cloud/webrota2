"""counter_opening_balance

Revision ID: 013
Revises: 012
Create Date: 2026-09-08 00:00:00

Storage for counter opening balances, so a doctor who joins part-way
through can be started level with their peers instead of at zero. Nothing
reads these yet -- this migration is the data model only.

`clinic_counters` and `system_counters` already have exactly the right row
grain (one per doctor per counted thing), so a column on each is the whole
change there. The `server_default="0"` is what makes it safe against
existing rows: every counter in an existing database becomes an explicit
zero balance, which is the behaviour it already had.

Duty has no counter table -- the annual count is a `func.count()` over
`duty_assignments` -- so its balance needs somewhere to live, and it is
year-scoped where the other two are not: the duty count restarts every 1
January, so a balance that outlived its year would keep crediting someone
who is no longer a new starter. `(doctor_id, year)` is the grain
`leave_entitlements` already uses for the same reason. Absent row means
zero, so nothing is seeded here.

No check constraint bounds the sign: negative balances are deliberate (a
doctor returning from a long absence, or a leaver whose count should read
as already served).

Only Postgres needs this migration -- CI runs `alembic upgrade head` /
`downgrade base` against it, while the test suite builds SQLite straight
from the models via `create_all`.

Downgrade drops the table and both columns, losing every balance. There is
nothing to preserve them in and no derivation to rebuild them from -- an
admin sets the number -- so the loss is real but bounded to a feature the
pre-013 code cannot read anyway.
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa

revision: str = "013"
down_revision: Union[str, None] = "012"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

_BALANCE_TABLES = ("clinic_counters", "system_counters")


def upgrade() -> None:
    for table in _BALANCE_TABLES:
        op.add_column(
            table,
            sa.Column(
                "opening_balance",
                sa.Numeric(5, 1),
                server_default="0",
                nullable=False,
            ),
        )

    op.create_table(
        "duty_opening_balances",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column(
            "doctor_id", sa.Integer(), sa.ForeignKey("doctors.id"), nullable=False
        ),
        sa.Column("year", sa.Integer(), nullable=False),
        sa.Column(
            "sessions", sa.Numeric(5, 1), server_default="0", nullable=False
        ),
        sa.Column("notes", sa.String(length=200), nullable=True),
        sa.UniqueConstraint(
            "doctor_id", "year", name="uq_duty_opening_balance_doctor_year"
        ),
    )


def downgrade() -> None:
    op.drop_table("duty_opening_balances")
    for table in _BALANCE_TABLES:
        op.drop_column(table, "opening_balance")
