"""password_reset_tokens

Revision ID: 011
Revises: 010
Create Date: 2026-09-07 00:00:00

Creates the table behind self-service password reset. The shape is
deliberately `sessions` again -- id, token_hash with a named unique
constraint, an indexed user_id FK, created_at, expires_at, all
timezone-aware -- so there is one set of conventions for bearer-token
storage rather than two. Only the SHA-256 digest is stored; see
app/models/user.py for the rest of the reasoning.

Two indexes, not one. `ix_password_reset_tokens_user_id` serves the
per-user lookups (the throttle check, the lazy sweep of expired rows, the
delete-all-outstanding on redemption or password change).
`ix_password_reset_tokens_created_at` serves the global cap, which counts
rows created in the last hour on every forgot-password request from an
unauthenticated caller. expires_at is not indexed: it is only ever filtered
alongside user_id.

No backfill and no server defaults: the table starts empty, and every row
is written by the application with all four values set. Rows are
short-lived by design (one hour, deleted on redemption), so there is
nothing here worth preserving.

Only Postgres needs this migration -- CI runs `alembic upgrade head` /
`downgrade base` against it, while the test suite builds SQLite straight
from the models via `create_all`.

Downgrade drops the indexes and the table. Any outstanding reset links
stop working, which is the correct outcome: a token whose row is gone is
indistinguishable from one that was spent.
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa

revision: str = "011"
down_revision: Union[str, None] = "010"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "password_reset_tokens",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("token_hash", sa.String(), nullable=False),
        sa.Column("user_id", sa.Integer(), sa.ForeignKey("users.id"), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=False),
        sa.UniqueConstraint(
            "token_hash", name="uq_password_reset_tokens_token_hash"
        ),
    )
    op.create_index(
        "ix_password_reset_tokens_user_id", "password_reset_tokens", ["user_id"]
    )
    op.create_index(
        "ix_password_reset_tokens_created_at", "password_reset_tokens", ["created_at"]
    )


def downgrade() -> None:
    op.drop_index(
        "ix_password_reset_tokens_created_at", table_name="password_reset_tokens"
    )
    op.drop_index(
        "ix_password_reset_tokens_user_id", table_name="password_reset_tokens"
    )
    op.drop_table("password_reset_tokens")
