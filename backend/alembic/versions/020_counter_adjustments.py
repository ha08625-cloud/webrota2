"""counter_adjustments

Revision ID: 020
Revises: 019
Create Date: 2026-09-15 00:00:00

Renames the opening-balance storage to the counter-adjustment storage. The
stored quantity is unchanged -- the same signed Numeric(5,1) in sessions,
added to the raw count before the weighted score is computed. What changes
is the concept it names: not "the balance a mid-year joiner opens with" but
"this counter does not reflect a fair share, nudge it", which also covers a
doctor returning from a compassionate or long-term absence.

Column and table renames preserve every stored value, so no adjustment is
lost here.

The one real drop is `duty_opening_balances.notes`. It is dropped rather
than carried through the rename because no code path has ever written it:
the duty grid never sent it, and only the hand-written frontend wire type
mentioned it. Keeping a column nothing can fill is worse than not having
one, and the audit log already records who set each adjustment and to what.
Note that the argument is "nothing ever wrote it", not "there is no
production data" -- this system is live, so the second claim is not one
this migration can make.

`op.batch_alter_table` carries the unique-constraint rename, per the
migrations rule that dev SQLite cannot alter a constraint in place.

Downgrade reverses both renames and re-adds `notes` nullable, which is the
state the pre-020 code expects: always null, because nothing wrote it.
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa

revision: str = "020"
down_revision: Union[str, None] = "019"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

_COUNTER_TABLES = ("clinic_counters", "system_counters")


def upgrade() -> None:
    for table in _COUNTER_TABLES:
        op.alter_column(table, "opening_balance", new_column_name="adjustment")

    op.rename_table("duty_opening_balances", "duty_counter_adjustments")
    op.alter_column(
        "duty_counter_adjustments", "sessions", new_column_name="adjustment"
    )
    op.drop_column("duty_counter_adjustments", "notes")
    with op.batch_alter_table("duty_counter_adjustments") as batch_op:
        batch_op.drop_constraint(
            "uq_duty_opening_balance_doctor_year", type_="unique"
        )
        batch_op.create_unique_constraint(
            "uq_duty_counter_adjustment_doctor_year", ["doctor_id", "year"]
        )


def downgrade() -> None:
    with op.batch_alter_table("duty_counter_adjustments") as batch_op:
        batch_op.drop_constraint(
            "uq_duty_counter_adjustment_doctor_year", type_="unique"
        )
        batch_op.create_unique_constraint(
            "uq_duty_opening_balance_doctor_year", ["doctor_id", "year"]
        )
    op.add_column(
        "duty_counter_adjustments",
        sa.Column("notes", sa.String(length=200), nullable=True),
    )
    op.alter_column(
        "duty_counter_adjustments", "adjustment", new_column_name="sessions"
    )
    op.rename_table("duty_counter_adjustments", "duty_opening_balances")

    for table in _COUNTER_TABLES:
        op.alter_column(table, "adjustment", new_column_name="opening_balance")
