"""users.permissions gains the `research` key

Revision ID: 016
Revises: 015
Create Date: 2026-09-15 00:00:00

The fifth top-level section (Research) is gated by a sixth permission,
`research`, levelled none/read/write like clinical and reception. See
app/models/permissions.py for what it means and why it is not lockable.

**Nothing here is load-bearing for correctness.** `PermissionSet`
(api/schemas/auth.py) defaults every field to denied, so a user row whose
stored JSON predates this key already serialises as `research: "none"`, and
the gates read the same default through `permissions.get(area)`. This
migration exists so the *database* says what the application means, rather
than leaving every pre-existing row quietly missing a key that the next
person to read the table by hand would have to know about.

Two pieces, both portable:

1. The column's `server_default` moves to the six-key deny-everything
   object. That default is what a row inserted outside the app gets, and a
   five-key default would mint rows missing the new key from today onward
   -- the exact state the backfill below is cleaning up.
2. Every existing row's object gains `"research": "none"`, rewritten whole
   rather than patched in SQL. Postgres could do this with `jsonb_set`, but
   the column is portable `JSON` (see the model), the dev database is
   SQLite, and a read-modify-write over a handful of user rows costs
   nothing. A row that somehow already has the key keeps its value. Each
   rewritten object is rebuilt in sorted key order: SQLAlchemy serialises a
   JSON column with plain `json.dumps`, which follows insertion order, and
   appending the new key would leave every backfilled row rendered in a
   different order from the server_default beside it.

Written against a lightweight `sa.table()` rather than the User model, and
with the key names spelled out below rather than imported, for the reason
migration 010 gives: a migration is a historical record and has to keep
doing the same thing after the application's permission set moves on again.

CI runs `alembic upgrade head` / `downgrade base` against real Postgres, and
the test suite builds SQLite straight from the models via `create_all`, so
this file is only ever exercised against Postgres and the dev SQLite file.

Downgrade strips the key back out and restores the five-key server_default.
It is lossless in the only sense that matters: anything the key granted is
gone, but no other permission is touched.
"""
import json
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa

revision: str = "016"
down_revision: Union[str, None] = "015"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

_KEY = "research"
_NONE = "none"

# The deny-everything set on either side of this migration, frozen here.
# sort_keys matches the model's server_default so the column default, the
# audit snapshot and this file render byte-identical JSON.
_DENY_ALL_BEFORE = {
    "clinical": _NONE,
    "reception": _NONE,
    "signatures": False,
    "study_eoi": False,
    "user_admin": False,
}
_DENY_ALL_AFTER = dict(_DENY_ALL_BEFORE, research=_NONE)

_users = sa.table(
    "users",
    sa.column("id", sa.Integer()),
    sa.column("permissions", sa.JSON()),
)


def _dumps(permissions: dict) -> str:
    return json.dumps(permissions, sort_keys=True)


def _set_server_default(permissions: dict) -> None:
    with op.batch_alter_table("users") as batch_op:
        batch_op.alter_column(
            "permissions",
            existing_type=sa.JSON(),
            existing_nullable=False,
            server_default=sa.text(f"'{_dumps(permissions)}'"),
        )


def _rewrite_permissions(mutate) -> None:
    """Read every user's permission object, apply `mutate`, write back.

    `mutate` returns the new object or None to leave the row alone, so a
    re-run (or a row already carrying the key) writes nothing.
    """
    connection = op.get_bind()
    rows = connection.execute(
        sa.select(_users.c.id, _users.c.permissions)
    ).fetchall()
    for user_id, permissions in rows:
        # SQLAlchemy deserialises a JSON column for us; a row holding
        # something that is not an object is not this migration's to fix.
        if not isinstance(permissions, dict):
            continue
        updated = mutate(permissions)
        if updated is None:
            continue
        updated = dict(sorted(updated.items()))
        connection.execute(
            _users.update()
            .where(_users.c.id == user_id)
            # The dict, not `_dumps(...)`: the column is declared JSON
            # above, so SQLAlchemy serialises it -- handing it a string
            # would store a JSON string containing an object.
            .values(permissions=updated)
        )


def upgrade() -> None:
    _set_server_default(_DENY_ALL_AFTER)
    _rewrite_permissions(
        lambda permissions: None
        if _KEY in permissions
        else dict(permissions, **{_KEY: _NONE})
    )


def downgrade() -> None:
    _set_server_default(_DENY_ALL_BEFORE)
    _rewrite_permissions(
        lambda permissions: {
            key: value for key, value in permissions.items() if key != _KEY
        }
        if _KEY in permissions
        else None
    )
