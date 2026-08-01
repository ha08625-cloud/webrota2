"""widen reception rota slots from hourly to half-hourly

Revision ID: 024
Revises: 023
Create Date: 2026-08-01 00:00:00

Reception rota `hour` columns move from Integer (whole hours, 8..17) to
Float (whole or half hours, 8.0..17.5) -- see the "Half-hour granularity"
note at the top of app/models/reception.py for why `hour` keeps its name
and type rather than being renamed to something like `slot`.

CLAUDE.md: the system is not yet live, so existing rows do not need to be
carried forward. That is not just a convenience here -- there is no correct
automatic mapping from an hourly row to a half-hourly one. An old row for
hour=9 meant "covering all of 9:00-10:00"; keeping it as-is under the new
schema would silently leave 9:30-10:00 uncovered, which is a worse outcome
than an empty table. So this migration clears the four reception tables
before changing the column type, rather than reinterpreting old values.
Re-seed via seed/seed_reception_coverage.py afterwards; the master template
has no seed script and was always populated by hand, same as before.

reception_rota_sessions is cleared before reception_rotas because the FK
between them has no ON DELETE CASCADE at the DB level (only the ORM
relationship cascades) -- deleting a referenced rota row first would fail.
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa

revision: str = "024"
down_revision: Union[str, None] = "023"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

_OLD_RANGE = "hour BETWEEN 8 AND 17"
_NEW_RANGE = "hour BETWEEN 8.0 AND 17.5 AND (hour * 2) = CAST(hour * 2 AS INTEGER)"

_TABLES = [
    ("reception_master_sessions", "ck_rms_hour"),
    ("reception_rota_sessions", "ck_rrs_hour"),
    ("reception_coverage_rules", "ck_rcr_hour"),
]


def upgrade() -> None:
    op.execute("DELETE FROM reception_rota_sessions")
    op.execute("DELETE FROM reception_rotas")
    op.execute("DELETE FROM reception_master_sessions")
    op.execute("DELETE FROM reception_coverage_rules")

    for table, ck_name in _TABLES:
        with op.batch_alter_table(table) as batch_op:
            batch_op.drop_constraint(ck_name, type_="check")
            batch_op.alter_column(
                "hour", existing_type=sa.Integer(), type_=sa.Float(), nullable=False,
            )
            batch_op.create_check_constraint(ck_name, _NEW_RANGE)


def downgrade() -> None:
    op.execute("DELETE FROM reception_rota_sessions")
    op.execute("DELETE FROM reception_rotas")
    op.execute("DELETE FROM reception_master_sessions")
    op.execute("DELETE FROM reception_coverage_rules")

    for table, ck_name in _TABLES:
        with op.batch_alter_table(table) as batch_op:
            batch_op.drop_constraint(ck_name, type_="check")
            batch_op.alter_column(
                "hour", existing_type=sa.Float(), type_=sa.Integer(), nullable=False,
            )
            batch_op.create_check_constraint(ck_name, _OLD_RANGE)
