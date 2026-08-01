"""add reception_leave_entries (reception leave)

Revision ID: 025
Revises: 024
Create Date: 2026-08-01 00:00:00

Adds `reception_leave_entries` -- staff_id, date, unique on the pair. No
`period` column and no `notes`: reception leave is whole-day only (see
ReceptionLeaveEntry's docstring). Additive only, nothing to backfill; every
existing generated day simply has no leave recorded against it, which is the
correct reading.
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa

revision: str = "025"
down_revision: Union[str, None] = "024"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "reception_leave_entries",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column(
            "staff_id",
            sa.Integer(),
            sa.ForeignKey("reception_staff.id"),
            nullable=False,
        ),
        sa.Column("date", sa.Date(), nullable=False),
        sa.UniqueConstraint("staff_id", "date", name="uq_rle_slot"),
    )


def downgrade() -> None:
    op.drop_table("reception_leave_entries")
