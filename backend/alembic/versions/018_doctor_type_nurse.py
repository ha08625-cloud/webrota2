"""doctor type: nurse

Revision ID: 018
Revises: 017
Create Date: 2026-09-15 00:00:00

Adds a sixth DoctorType value, "Nurse". It carries no columns and no rules
of its own yet -- everywhere the engine branches on doctor type a nurse is
treated exactly as an AHP -- so the schema change is just the new enum
value, the same shape as migration 004's ReceptionRole additions. SQLite
renders the enum as VARCHAR + CHECK rebuilt from the Python enum at
`create_all` time and needs no migration; only the Postgres native type
does.

`IF NOT EXISTS` is load-bearing rather than defensive: migration 001 builds
its native enum types from the *current* Python enums, so on a database
created from scratch today `doctor_type` already has "Nurse" by the time
this revision runs, and the statement must be a no-op there.

Downgrade rebuilds the native type without "Nurse" (Postgres has no
`DROP VALUE`), the standard rename/recreate/swap dance. It fails if any
doctor row is still a nurse, which is the accepted behaviour for narrowing
an enum back down.
"""
from typing import Sequence, Union

from alembic import op

revision: str = "018"
down_revision: Union[str, None] = "017"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

_OLD_VALUES = ["Partner", "Salaried", "Trainee", "Locum", "AHP"]


def upgrade() -> None:
    if op.get_bind().dialect.name != "postgresql":
        return
    op.execute("ALTER TYPE doctor_type ADD VALUE IF NOT EXISTS 'Nurse'")


def downgrade() -> None:
    if op.get_bind().dialect.name != "postgresql":
        return
    op.execute("ALTER TYPE doctor_type RENAME TO doctor_type_old")
    values_sql = ", ".join(f"'{v}'" for v in _OLD_VALUES)
    op.execute(f"CREATE TYPE doctor_type AS ENUM ({values_sql})")
    op.execute(
        "ALTER TABLE doctors ALTER COLUMN doctor_type TYPE doctor_type "
        "USING doctor_type::text::doctor_type"
    )
    op.execute("DROP TYPE doctor_type_old")
