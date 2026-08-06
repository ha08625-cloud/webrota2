"""add leave_entitlements (leave entitlement and balances)

Revision ID: 026
Revises: 025
Create Date: 2026-08-06 00:00:00

Adds `leave_entitlements` -- doctor_id, year, an optional entitlement
override and two additive columns (carry-over, adjustment), unique on
(doctor_id, year).

Additive only, and deliberately **not** backfilled: a doctor with no row
gets the rule figure (7 weeks for a partner, 6 for salaried/trainee,
weighted by sessions_per_week and pro-rated by the employment window),
computed at read time. Seeding a row per doctor per year would freeze that
figure against the `sessions_per_week` in force today and quietly stop
tracking changes to it.
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa

revision: str = "026"
down_revision: Union[str, None] = "025"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "leave_entitlements",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column(
            "doctor_id",
            sa.Integer(),
            sa.ForeignKey("doctors.id"),
            nullable=False,
        ),
        sa.Column("year", sa.Integer(), nullable=False),
        sa.Column("entitlement_sessions", sa.Numeric(5, 1), nullable=True),
        sa.Column(
            "carry_over_sessions",
            sa.Numeric(5, 1),
            nullable=False,
            server_default="0",
        ),
        sa.Column(
            "adjustment_sessions",
            sa.Numeric(5, 1),
            nullable=False,
            server_default="0",
        ),
        sa.Column("notes", sa.String(length=200), nullable=True),
        sa.UniqueConstraint(
            "doctor_id", "year", name="uq_leave_entitlement_doctor_year"
        ),
    )


def downgrade() -> None:
    op.drop_table("leave_entitlements")
