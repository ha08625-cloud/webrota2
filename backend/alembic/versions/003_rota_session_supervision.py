"""add RotaSession.is_supervising (Phase 9C)

Revision ID: 003
Revises: 002
Create Date: 2026-07-13 00:00:00

Adds a single non-nullable boolean column, default False. Unlike 002's
template_type (nullable, no backfill needed), this table already has rows
in any deployed environment, so a server_default is required at add-column
time -- existing rows backfill to False, which is the correct reading:
pre-migration rotas genuinely have no supervision recorded (Phase 9C
implementation plan, Decision 7 -- this is accepted as correct, not a
migration artifact to paper over).

No enum involved, so none of 001/002's enum-type-reuse handling applies.
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa

revision: str = "003"
down_revision: Union[str, None] = "002"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "rota_sessions",
        sa.Column(
            "is_supervising", sa.Boolean(), nullable=False, server_default=sa.false()
        ),
    )


def downgrade() -> None:
    op.drop_column("rota_sessions", "is_supervising")