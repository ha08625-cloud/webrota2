"""add users, sessions (auth plan, Task 1)

Revision ID: 010
Revises: 009
Create Date: 2026-07-18 00:00:00

Two new tables, additive only. No enums involved, so none of 001/002's
enum-type-reuse handling applies.

users: email/name/password_hash, active (soft-disable), created_at.
unique(email) is the lookup index for login, same pattern as
doctor_signatures.doctor_id in migration 009 -- no separate
op.create_index call needed.

sessions: token_hash (unique -- the lookup index for bearer-token auth),
user_id (FK to users.id, indexed for the cascade-delete-orphan pattern
the ORM relationship uses), created_at, expires_at. Only the SHA-256
digest of the session token is ever stored; see the User/UserSession
model docstring. No DB-level ON DELETE CASCADE (none exists anywhere in
this schema) -- cascade is ORM-level only, same as generated_rotas'
children.
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa

revision: str = "010"
down_revision: Union[str, None] = "009"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "users",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("email", sa.String(), nullable=False),
        sa.Column("name", sa.String(), nullable=False),
        sa.Column("password_hash", sa.String(), nullable=False),
        sa.Column("active", sa.Boolean(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.UniqueConstraint("email", name="uq_users_email"),
    )

    op.create_table(
        "sessions",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("token_hash", sa.String(), nullable=False),
        sa.Column(
            "user_id", sa.Integer(),
            sa.ForeignKey("users.id"), nullable=False,
        ),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=False),
        sa.UniqueConstraint("token_hash", name="uq_sessions_token_hash"),
    )
    op.create_index("ix_sessions_user_id", "sessions", ["user_id"])


def downgrade() -> None:
    op.drop_index("ix_sessions_user_id", table_name="sessions")
    op.drop_table("sessions")
    op.drop_table("users")
