"""edit_locks

Revision ID: 014
Revises: 013
Create Date: 2026-09-12 00:00:00

The section editing lock table. At most two rows
ever exist -- one per lockable area, `clinical` and `reception` -- and that
is structural: `area` is the primary key, so "one lock per section" cannot
be violated by a race in the acquire endpoint.

`area` is a plain string rather than a native Postgres enum. The values are
constrained to models/permissions.LOCKABLE_AREAS in application code, which
means making a future section lockable is a code change and not an
ALTER TYPE -- and an enum here would duplicate a list this schema already
keeps as JSON strings in `users.permissions`.

No ON DELETE CASCADE on the user FK, in keeping with the rest of this
schema (see 001_initial_schema.py): logins are deactivated rather than
deleted, so a lock row whose holder has vanished should surface as a
problem rather than disappear quietly.

Both timestamps are timezone-aware and written in UTC. Nothing is seeded:
no row means nobody is in the section, which is the normal state.

Only Postgres needs this migration -- CI runs `alembic upgrade head` /
`downgrade base` against it, while the test suite builds SQLite straight
from the models via `create_all`.

Downgrade drops the table. Nothing is lost that matters: a lock is
ephemeral state about who is editing right now, and the pre-014 code
cannot read it.
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa

revision: str = "014"
down_revision: Union[str, None] = "013"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "edit_locks",
        sa.Column("area", sa.String(), nullable=False),
        sa.Column("user_id", sa.Integer(), nullable=False),
        sa.Column("acquired_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column(
            "last_activity_at", sa.DateTime(timezone=True), nullable=False
        ),
        sa.PrimaryKeyConstraint("area", name="pk_edit_locks"),
        sa.ForeignKeyConstraint(
            ["user_id"], ["users.id"], name="fk_edit_locks_user_id_users"
        ),
    )


def downgrade() -> None:
    op.drop_table("edit_locks")
