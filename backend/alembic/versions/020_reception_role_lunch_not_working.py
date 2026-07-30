"""expand reception_role with lunch/not_working

Revision ID: 020
Revises: 019
Create Date: 2026-07-30 00:00:00

Adds two new ReceptionRole values -- lunch, not_working -- alongside the
nine already added by 018/019. Same as every other role added since 013:
a plain tag on a reception_master_sessions/reception_rota_sessions row,
with no minimum-staffing concept and no effect on compute_coverage_issues
(phones-only, unchanged).

`not_working` is a tag, not a replacement for row deletion -- Decision 10
in documentation/architecture-reception.md still holds: absence from a
day rota is expressed by deleting the row, and coverage still counts
"anyone holding a phones row for an hour, full stop". Tagging a *master
template* cell `not_working` only records "this staff member does not
work this slot in the template" for display purposes; generating a day
still copies the row as-is (Decision 3/5), so the day-rota row exists and
must still be deleted there to be read as absent.

Same ADD VALUE IF NOT EXISTS pattern as 013/019: guarded to Postgres only
(SQLite regenerates reception_role as VARCHAR + CHECK from the live
Python enum at create_all time), and IF NOT EXISTS is mandatory rather
than defensive since a fresh `alembic upgrade head` creates the type
already containing every current enum value.

downgrade() is a no-op for the same reason as 013/019: Postgres has no
DROP VALUE, and a full downgrade to base drops the whole type via 018's
_drop_reception_role_type() anyway.
"""
from typing import Sequence, Union

from alembic import op

revision: str = "020"
down_revision: Union[str, None] = "019"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

_NEW_VALUES = [
    "lunch",
    "not_working",
]


def upgrade() -> None:
    if op.get_bind().dialect.name != "postgresql":
        return
    for value in _NEW_VALUES:
        op.execute(f"ALTER TYPE reception_role ADD VALUE IF NOT EXISTS '{value}'")


def downgrade() -> None:
    pass
