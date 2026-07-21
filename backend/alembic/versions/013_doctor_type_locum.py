"""add Locum to DoctorType

Revision ID: 013
Revises: 012
Create Date: 2026-07-21 00:00:00

Adds the fifth DoctorType value, "Locum" (Trainee-minus-supervision; see
docs/domain-model.md). This migration only touches the Postgres native enum
type -- SQLite renders doctor_type as VARCHAR + CHECK, regenerated from the
live Python enum at create_all time, so it needs no migration step here.

`IF NOT EXISTS` is mandatory, not defensive. 001_initial_schema.py creates
every native enum type from the *current* contents of app.models.enums
(_create_enum_types(), iterating _ALL_ENUMS). Once LOCUM is added to
DoctorType, a fresh `alembic upgrade head` -- including CI's from-scratch
job -- creates doctor_type already containing 'Locum'. A plain `ALTER TYPE
... ADD VALUE 'Locum'` would then fail with "already exists" on that fresh
database. `IF NOT EXISTS` makes this migration correct both there and
against the already-deployed Railway database, where the value is genuinely
new.

No autocommit block is needed: `ALTER TYPE ... ADD VALUE` has been
transaction-safe since Postgres 12 (CI runs postgres:16), and this
migration never uses the new value in the same transaction that adds it.

downgrade() is a deliberate no-op. Postgres has no `DROP VALUE`; rebuilding
doctor_type without 'Locum' would leave it diverging from what a fresh 001
produces, and 001's own _drop_enum_types() drops the whole type anyway on a
full downgrade to base. With `IF NOT EXISTS` on the way back up, the CI
upgrade/downgrade/upgrade round trip still passes -- on a fresh database
this migration is a no-op in both directions, and it exists for the
deployed database and the audit trail.

The literal 'Locum' is hardcoded rather than built from DoctorType.LOCUM.value
deliberately: a migration describes one fixed historical step, not whatever
the enum happens to contain when someone later reads this file.
"""
from typing import Sequence, Union

from alembic import op

revision: str = "013"
down_revision: Union[str, None] = "012"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    if op.get_bind().dialect.name != "postgresql":
        return
    op.execute("ALTER TYPE doctor_type ADD VALUE IF NOT EXISTS 'Locum'")


def downgrade() -> None:
    pass