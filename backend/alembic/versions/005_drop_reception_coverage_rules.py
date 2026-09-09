"""drop reception_coverage_rules

Revision ID: 005
Revises: 004
Create Date: 2026-08-17 00:00:00

Reception phone coverage is now a flat constant (MIN_PHONES_STAFF in
app/models/reception.py), not a per-(day, hour) rule -- there is no more
coverage-rules editor in the UI, so the table backing it (and its GET/PATCH
router) is removed rather than left unreachable. See
documentation/architecture-reception.md.

Downgrade recreates the table exactly as 001_initial_schema.py did, empty --
the row data is not recoverable, and the system predates go-live so no
production data needs to survive this either direction.
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

from app.models.enums import Day, _snake

revision: str = "005"
down_revision: Union[str, None] = "004"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def _day_type():
    if op.get_bind().dialect.name == "postgresql":
        return postgresql.ENUM(
            Day, name=_snake(Day.__name__), create_type=False,
            values_callable=lambda e: [m.value for m in e],
        )
    return sa.Enum(Day, name=_snake(Day.__name__), values_callable=lambda e: [m.value for m in e])


def upgrade() -> None:
    op.drop_table("reception_coverage_rules")


def downgrade() -> None:
    op.create_table(
        "reception_coverage_rules",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("day", _day_type(), nullable=False),
        sa.Column("hour", sa.Float(), nullable=False),
        sa.Column("min_phones_staff", sa.Integer(), nullable=False),
        sa.CheckConstraint(
            "hour BETWEEN 7.5 AND 18.0 AND (hour * 2) = CAST(hour * 2 AS INTEGER)",
            name="ck_rcr_hour",
        ),
        sa.UniqueConstraint("day", "hour", name="uq_rcr_slot"),
    )
