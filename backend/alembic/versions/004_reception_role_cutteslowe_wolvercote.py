"""reception role: cutteslowe, wolvercote

Revision ID: 004
Revises: 003
Create Date: 2026-08-17 00:00:00

Adds two more plain tag values to ReceptionRole -- see the "ReceptionRole has
eleven values" section of documentation/architecture-reception.md: a role
here is a label with no fields of its own, and adding one is exactly this,
an `ALTER TYPE ... ADD VALUE`. SQLite renders the enum as VARCHAR + CHECK
built fresh from the Python enum at `create_all` time, so it needs no
migration; only the Postgres native type does.

Downgrade rebuilds the native type without the two values (Postgres has no
`DROP VALUE`), the standard rename/recreate/swap dance -- it will fail if any
row already uses `cutteslowe` or `wolvercote`, which is the expected/accepted
behaviour for narrowing an enum back down.
"""
from typing import Sequence, Union

from alembic import op

revision: str = "004"
down_revision: Union[str, None] = "003"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

_OLD_VALUES = [
    "phones", "prescriptions", "registrations", "front_desk", "admin",
    "online_triage", "rotas", "tasks", "lunch", "not_working", "other",
]
_TABLES = ["reception_master_sessions", "reception_rota_sessions"]


def upgrade() -> None:
    if op.get_bind().dialect.name != "postgresql":
        return
    op.execute("ALTER TYPE reception_role ADD VALUE IF NOT EXISTS 'cutteslowe'")
    op.execute("ALTER TYPE reception_role ADD VALUE IF NOT EXISTS 'wolvercote'")


def downgrade() -> None:
    if op.get_bind().dialect.name != "postgresql":
        return
    op.execute("ALTER TYPE reception_role RENAME TO reception_role_old")
    values_sql = ", ".join(f"'{v}'" for v in _OLD_VALUES)
    op.execute(f"CREATE TYPE reception_role AS ENUM ({values_sql})")
    for table in _TABLES:
        op.execute(
            f"ALTER TABLE {table} ALTER COLUMN role TYPE reception_role "
            f"USING role::text::reception_role"
        )
    op.execute("DROP TYPE reception_role_old")
