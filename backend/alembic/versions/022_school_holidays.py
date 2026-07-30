"""add schools and school_holidays

Revision ID: 022
Revises: 021
Create Date: 2026-07-30 00:00:00

Creates the `schools` and `school_holidays` tables. Global planning data
with zero engine coupling -- see app/models/school.py. The system is not
yet live so there is no data to migrate.
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa

revision: str = "022"
down_revision: Union[str, None] = "021"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "schools",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("name", sa.String(), nullable=False),
        sa.UniqueConstraint("name", name="uq_school_name"),
    )
    op.create_table(
        "school_holidays",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("school_id", sa.Integer(), nullable=False),
        sa.Column("start_date", sa.Date(), nullable=False),
        sa.Column("end_date", sa.Date(), nullable=False),
        sa.Column("name", sa.String(), nullable=True),
        sa.ForeignKeyConstraint(
            ["school_id"], ["schools.id"], ondelete="CASCADE"
        ),
    )
    op.create_index(
        "ix_school_holidays_school_id", "school_holidays", ["school_id"]
    )


def downgrade() -> None:
    op.drop_index("ix_school_holidays_school_id", table_name="school_holidays")
    op.drop_table("school_holidays")
    op.drop_table("schools")
