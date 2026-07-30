"""add bank_holiday_key to practice_closures

Revision ID: 021
Revises: 020
Create Date: 2026-07-30 00:00:00

Adds a nullable `bank_holiday_key` column to `practice_closures`, tagging a
row as the annual instance of one of the fixed named bank holidays
(app/models/bank_holidays.py) rather than an ad-hoc closure. Nullable with
no backfill: existing ad-hoc closures simply have no key, and the system is
not yet live so there is no data to migrate.
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa

revision: str = "021"
down_revision: Union[str, None] = "020"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "practice_closures",
        sa.Column("bank_holiday_key", sa.String(), nullable=True),
    )


def downgrade() -> None:
    op.drop_column("practice_closures", "bank_holiday_key")
