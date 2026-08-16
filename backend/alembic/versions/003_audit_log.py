"""audit log

Revision ID: 003
Revises: 002
Create Date: 2026-08-16 00:00:00

Creates `audit_log`: one row per write request that reaches the API, written
only by the audit middleware. See `app/models/audit.py` for why the identity
columns are frozen snapshots and why `user_access_level` is a plain string
rather than a native enum -- the practical consequence here is that this
migration creates no enum type, so `downgrade()` is a plain drop with no
`DROP TYPE` cleanup.

Only `at` and `user_id` are indexed. `path` is not: the only filter against
it is a leading-wildcard LIKE, which a B-tree index cannot serve.
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa

revision: str = "003"
down_revision: Union[str, None] = "002"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "audit_log",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("user_id", sa.Integer(), sa.ForeignKey("users.id"), nullable=True),
        sa.Column("user_email", sa.String(), nullable=True),
        sa.Column("user_access_level", sa.String(), nullable=True),
        sa.Column("method", sa.String(10), nullable=False),
        sa.Column("route", sa.String(), nullable=True),
        sa.Column("path", sa.String(), nullable=False),
        sa.Column("path_params", sa.JSON(), nullable=True),
        sa.Column("request_body", sa.JSON(), nullable=True),
        sa.Column("status_code", sa.Integer(), nullable=False),
        sa.Column("outcome_detail", sa.Text(), nullable=True),
        sa.Column("duration_ms", sa.Integer(), nullable=True),
        sa.Column("client_ip", sa.String(), nullable=True),
    )
    op.create_index("ix_audit_log_at", "audit_log", ["at"])
    op.create_index("ix_audit_log_user_id", "audit_log", ["user_id"])


def downgrade() -> None:
    op.drop_index("ix_audit_log_user_id", table_name="audit_log")
    op.drop_index("ix_audit_log_at", table_name="audit_log")
    op.drop_table("audit_log")
