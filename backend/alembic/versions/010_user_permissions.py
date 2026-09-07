"""users.permissions / audit_log.user_permissions

Revision ID: 010
Revises: 009
Create Date: 2026-09-07 00:00:00

Adds the per-user permission set (fine-grained permissions plan, D3) and
the audit log's snapshot of it (D13). Until now the only thing that decided
what a login could do was `access_level`, a single four-value tier; see
app/models/permissions.py for the shape that replaces it and why it is one
JSON column rather than five boolean ones or an association table.

`users.permissions` is NOT NULL with a deny-everything server_default, so a
row inserted outside the app (a script, a psql session) is safe by default
-- the same reasoning that gives `access_level` its `nurse` server_default.
The type is portable JSON rather than JSONB: the test suite builds SQLite
from the models, and nothing here queries into the column with an operator
JSONB would accelerate.

The backfill maps each existing row's tier onto the closest preset --
manager -> Manager, admin -> Rota admin, doctor/nurse -> Read-only. Note
what that does to an `admin`: the Rota admin preset does NOT include
signatures, which today's admin tier can use. That narrowing is the point
of the feature, and it is why the backfill is spelled out here rather than
left to the server_default.

The backfill is written against a lightweight `sa.table()` rather than the
User model: a migration is a historical record, and importing the model
would make this file's behaviour change every time the model does. The
presets are duplicated below for the same reason.

Both bound values are plain strings on the wire and rely on Postgres
resolving an unknown-typed literal to the column's type: the JSON object to
`json`, and the tier to the native `accesslevel` enum. That is how every
ordinary INSERT through the ORM already binds these two columns, and it
avoids a `::text` cast that SQLite would not accept.

`audit_log.user_permissions` is a plain nullable String beside
`user_access_level`, not a JSON column: it is a frozen snapshot displayed
as text and never queried into. There is no backfill for it -- historical
rows genuinely have no permission set to record, and NULL says exactly
that.

Only Postgres needs this migration (CI runs `alembic upgrade head` /
`downgrade base` against it); the test suite builds SQLite straight from
the models via `create_all`. `batch_alter_table` is used anyway, for the
dev SQLite database, and because a NOT NULL add with a server_default is
one of the cases SQLite's plain ALTER handles badly.

Downgrade drops both columns. The permission sets are not recoverable
afterwards -- `access_level` still stands, so the pre-permissions tier
behaviour is intact, but any per-user deviation from the presets is lost.
"""
import json
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa

revision: str = "010"
down_revision: Union[str, None] = "009"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

# Duplicated from app/models/permissions.py rather than imported: a
# migration is a historical record and must keep running unchanged after
# the application's presets move on. sort_keys matches the model's
# server_default so the two render byte-identical JSON.
_NONE = "none"
_READ = "read"
_WRITE = "write"

_DENY_ALL = {
    "clinical": _NONE,
    "reception": _NONE,
    "signatures": False,
    "study_eoi": False,
    "user_admin": False,
}

_BACKFILL = {
    "manager": {
        "clinical": _WRITE,
        "reception": _WRITE,
        "signatures": True,
        "study_eoi": True,
        "user_admin": True,
    },
    "admin": {
        "clinical": _WRITE,
        "reception": _WRITE,
        "signatures": False,
        "study_eoi": False,
        "user_admin": False,
    },
    "doctor": {
        "clinical": _READ,
        "reception": _READ,
        "signatures": False,
        "study_eoi": False,
        "user_admin": False,
    },
}
_BACKFILL["nurse"] = _BACKFILL["doctor"]


def _dumps(permissions: dict) -> str:
    return json.dumps(permissions, sort_keys=True)


def upgrade() -> None:
    with op.batch_alter_table("users") as batch_op:
        batch_op.add_column(
            sa.Column(
                "permissions",
                sa.JSON(),
                nullable=False,
                server_default=sa.text(f"'{_dumps(_DENY_ALL)}'"),
            )
        )

    users = sa.table(
        "users",
        sa.column("permissions", sa.JSON()),
        sa.column("access_level", sa.String()),
    )
    for access_level, permissions in _BACKFILL.items():
        op.execute(
            users.update()
            .where(users.c.access_level == access_level)
            # The dict, not `_dumps(...)`: the column is declared JSON
            # above, so SQLAlchemy serialises it -- handing it a string
            # would store a JSON string containing an object.
            .values(permissions=permissions)
        )

    with op.batch_alter_table("audit_log") as batch_op:
        batch_op.add_column(
            sa.Column("user_permissions", sa.String(), nullable=True)
        )


def downgrade() -> None:
    with op.batch_alter_table("audit_log") as batch_op:
        batch_op.drop_column("user_permissions")

    with op.batch_alter_table("users") as batch_op:
        batch_op.drop_column("permissions")
