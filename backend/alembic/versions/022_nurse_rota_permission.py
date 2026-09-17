"""users.permissions gains the `nurse_rota` key

Revision ID: 022
Revises: 021
Create Date: 2026-09-17 00:00:00

The sixth top-level section (Nurse Rota) is gated by a seventh permission,
`nurse_rota`, levelled none/read/write like clinical, reception and
research. Unlike research it IS lockable -- see app/models/permissions.py
for why, and for the one thing that makes two locks over the single
`master_rota_sessions` table meaningful.

**Nothing here is load-bearing for correctness**, for the reason migration
016 gives at length: `PermissionSet` (api/schemas/auth.py) defaults every
field to denied, so a user row whose stored JSON predates this key already
serialises as `nurse_rota: "none"`, and the gates read the same default
through `permissions.get(area)`. This migration exists so the *database*
says what the application means.

Deliberately the same two pieces, in the same shape, as 016 -- the column's
`server_default` moves to the seven-key deny-everything object, and every
existing row's object gains `"nurse_rota": "none"`, rewritten whole in
sorted key order rather than patched in SQL. See 016's docstring for the
argument for each choice; a second idiom for the same job would be worse
than a copy.

Written against a lightweight `sa.table()` rather than the User model, and
with the key names spelled out below rather than imported, for the reason
migration 010 gives: a migration is a historical record and has to keep
doing the same thing after the application's permission set moves on again.

Downgrade strips the key back out and restores the six-key server_default.
It is lossless in the only sense that matters: anything the key granted is
gone, but no other permission is touched.
"""
import json
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa

revision: str = "022"
down_revision: Union[str, None] = "021"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

_KEY = "nurse_rota"
_NONE = "none"

# The deny-everything set on either side of this migration, frozen here.
# sort_keys matches the model's server_default so the column default, the
# audit snapshot and this file render byte-identical JSON.
_DENY_ALL_BEFORE = {
    "clinical": _NONE,
    "reception": _NONE,
    "research": _NONE,
    "signatures": False,
    "study_eoi": False,
    "user_admin": False,
}
_DENY_ALL_AFTER = dict(_DENY_ALL_BEFORE, nurse_rota=_NONE)

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
