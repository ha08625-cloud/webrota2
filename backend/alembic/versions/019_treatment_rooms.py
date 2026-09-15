"""treatment rooms: TR1, TR2, TR3, CK

Revision ID: 019
Revises: 018
Create Date: 2026-09-15 00:00:00

Adds a fifth RoomType value, "TR", and the four physical rooms that carry
it: TR1/TR2/TR3 (treatment rooms at SHC) and CK (the Cutteslowe kitchen).
The type says "nurse room the generation engine never allocates"; the
`site` column says where the room is, which is why CK is TR rather than C.

`/rooms` is read-only and `seed/seed_rooms.py` only runs against a fresh
database, so the rows have to arrive by migration on production.

Three things about the shape of this revision:

* `IF NOT EXISTS` on the ADD VALUE is load-bearing rather than defensive:
  migration 001 builds its native enum types from the *current* Python
  enums, so on a database created from scratch today `room_type` already
  has "TR" by the time this revision runs, and the statement must be a
  no-op there. Same reasoning as 018.
* The `autocommit_block` is required. Postgres forbids using a value added
  by `ALTER TYPE ... ADD VALUE` later in the transaction that added it, and
  `alembic/env.py` wraps *every* pending revision in one transaction (no
  `transaction_per_migration`), so splitting the ALTER into its own
  revision would not help. The block commits the surrounding transaction,
  runs the ALTER in autocommit and reopens, after which the INSERT may use
  'TR'.
* SQLite renders the enum as VARCHAR + CHECK rebuilt from the Python enum
  at `create_all` time and needs no DDL, so the ALTER is Postgres-only.
  The INSERT runs on every dialect.

Downgrade deletes the four rooms and rebuilds the native type without
"TR" (Postgres has no `DROP VALUE`), the standard rename/recreate/swap
dance. Unlike 018, `room_type` is used by three tables, so all three
columns need the cast. The delete fails on FK references from
`master_rota_sessions.room_id` or `rota_sessions.room_id`, which is the
accepted behaviour for narrowing an enum back down.
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "019"
down_revision: Union[str, None] = "018"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

# (code, room_type, site)
_ROOMS = [
    ("TR1", "TR", "SHC"),
    ("TR2", "TR", "SHC"),
    ("TR3", "TR", "SHC"),
    ("CK", "TR", "Cutteslowe"),
]

_OLD_VALUES = ["D", "C", "W", "SR"]

# rooms.room_type is the obvious one; the other two are the room_id/room_type
# XOR columns from migration 001.
_ENUM_COLUMNS = [
    ("rooms", "room_type"),
    ("doctor_preferred_rooms", "room_type"),
    ("clinic_type_room_eligibilities", "room_type"),
]


def upgrade() -> None:
    if op.get_bind().dialect.name == "postgresql":
        with op.get_context().autocommit_block():
            op.execute("ALTER TYPE room_type ADD VALUE IF NOT EXISTS 'TR'")

    bind = op.get_bind()
    existing = set(bind.scalars(sa.text("SELECT code FROM rooms")))
    for code, room_type, site in _ROOMS:
        if code in existing:
            continue
        op.execute(
            "INSERT INTO rooms (code, room_type, site) "
            f"VALUES ('{code}', '{room_type}', '{site}')"
        )


def downgrade() -> None:
    codes = ", ".join(f"'{code}'" for code, _, _ in _ROOMS)
    op.execute(f"DELETE FROM rooms WHERE code IN ({codes})")

    if op.get_bind().dialect.name != "postgresql":
        return
    op.execute("ALTER TYPE room_type RENAME TO room_type_old")
    values_sql = ", ".join(f"'{v}'" for v in _OLD_VALUES)
    op.execute(f"CREATE TYPE room_type AS ENUM ({values_sql})")
    for table, column in _ENUM_COLUMNS:
        op.execute(
            f"ALTER TABLE {table} ALTER COLUMN {column} TYPE room_type "
            f"USING {column}::text::room_type"
        )
    op.execute("DROP TYPE room_type_old")
