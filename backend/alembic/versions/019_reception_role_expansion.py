"""expand reception_role with new roles

Revision ID: 019
Revises: 018
Create Date: 2026-07-30 00:00:00

Adds seven new ReceptionRole values -- prescriptions, registrations,
front_desk, admin, online_triage, rotas, tasks -- alongside the existing
phones/other pair. Coverage rules (min_phones_staff, phones_shortfall)
stay phones-only by design; the new values are plain tags on a
reception_master_sessions/reception_rota_sessions row, same as `other`
today, with no minimum-staffing concept attached.

Same pattern as 013_doctor_type_locum.py: `ADD VALUE IF NOT EXISTS` per
value (Postgres has no multi-value form), guarded to Postgres only since
SQLite renders reception_role as VARCHAR + CHECK regenerated from the live
Python enum at create_all time. `IF NOT EXISTS` is mandatory rather than
defensive for the same reason as 013 -- a fresh `alembic upgrade head`
creates reception_role (018's _create_reception_role_type) already
containing every value in the current app.models.enums.ReceptionRole, so a
plain ADD VALUE would fail "already exists" on a from-scratch database
while still being needed against the already-deployed one.

No autocommit block needed (ADD VALUE has been transaction-safe since
Postgres 12; CI runs postgres:16) and no value is used in the same
transaction that adds it.

downgrade() is a no-op for the same reason as 013: Postgres has no DROP
VALUE, and a full downgrade to base drops the whole type via 018's
_drop_reception_role_type() anyway.

Values are hardcoded as literals rather than built from ReceptionRole
members -- a migration describes one fixed historical step, not whatever
the enum happens to contain when someone later reads this file.
"""
from typing import Sequence, Union

from alembic import op

revision: str = "019"
down_revision: Union[str, None] = "018"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

_NEW_VALUES = [
    "prescriptions",
    "registrations",
    "front_desk",
    "admin",
    "online_triage",
    "rotas",
    "tasks",
]


def upgrade() -> None:
    if op.get_bind().dialect.name != "postgresql":
        return
    for value in _NEW_VALUES:
        op.execute(f"ALTER TYPE reception_role ADD VALUE IF NOT EXISTS '{value}'")


def downgrade() -> None:
    pass
