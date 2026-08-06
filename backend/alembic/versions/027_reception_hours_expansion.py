"""widen reception rota opening hours from 8:00-18:00 to 7:30-18:30

Revision ID: 027
Revises: 026
Create Date: 2026-08-06 00:00:00

Widens RECEPTION_FIRST_HOUR/RECEPTION_LAST_HOUR from 8.0/17.5 to 7.5/18.0 --
see "Hour model (Decision 2)" in documentation/architecture-reception.md:
"widening the practice's opening hours is a migration (widening the check
constraint) plus inserting new reception_coverage_rules rows for the added
hours, not a configuration change."

Only the check constraint on reception_master_sessions/reception_rota_sessions/
reception_coverage_rules widens -- the column type (Float) and half-hour-step
rule are unchanged, and existing rows all still satisfy the new, wider range,
so nothing needs clearing (unlike migration 024, which changed the column
type itself).

reception_coverage_rules is additionally seeded with a row per weekday for
each of the two new slots (7.5 and 18.0), min_phones_staff=2, matching
seed_reception_coverage.py's default for a non-busy slot -- without this, the
two new slots would silently have no coverage minimum (a missing (day, hour)
row reads as "no minimum", per Decision 8) rather than the same baseline
staffing floor as every other quiet slot in the day.
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa

revision: str = "027"
down_revision: Union[str, None] = "026"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

_OLD_RANGE = "hour BETWEEN 8.0 AND 17.5 AND (hour * 2) = CAST(hour * 2 AS INTEGER)"
_NEW_RANGE = "hour BETWEEN 7.5 AND 18.0 AND (hour * 2) = CAST(hour * 2 AS INTEGER)"

_TABLES = [
    ("reception_master_sessions", "ck_rms_hour"),
    ("reception_rota_sessions", "ck_rrs_hour"),
    ("reception_coverage_rules", "ck_rcr_hour"),
]

_DAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday"]
_NEW_HOURS = [7.5, 18.0]

reception_coverage_rules = sa.table(
    "reception_coverage_rules",
    sa.column("day", sa.String),
    sa.column("hour", sa.Float),
    sa.column("min_phones_staff", sa.Integer),
)


def upgrade() -> None:
    for table, ck_name in _TABLES:
        with op.batch_alter_table(table) as batch_op:
            batch_op.drop_constraint(ck_name, type_="check")
            batch_op.create_check_constraint(ck_name, _NEW_RANGE)

    op.bulk_insert(
        reception_coverage_rules,
        [
            {"day": day, "hour": hour, "min_phones_staff": 2}
            for day in _DAYS
            for hour in _NEW_HOURS
        ],
    )


def downgrade() -> None:
    op.execute(
        "DELETE FROM reception_coverage_rules WHERE hour IN (7.5, 18.0)"
    )

    for table, ck_name in _TABLES:
        with op.batch_alter_table(table) as batch_op:
            batch_op.drop_constraint(ck_name, type_="check")
            batch_op.create_check_constraint(ck_name, _OLD_RANGE)
