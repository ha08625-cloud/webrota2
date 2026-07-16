"""add GeneratedRota.archived_at (archive committed rotas)

Revision ID: 008
Revises: 007
Create Date: 2026-07-16 00:00:00

Adds a single nullable DateTime column, no backfill and no server_default
-- matching 006's committed_at pattern, because null has a defined,
permanent meaning here ("not archived") rather than being a temporary
backfill gap.

Existing rotas (any environment, committed or not) read as
archived_at = NULL, i.e. not archived. This is correct with no data
migration needed: archiving is a pure visibility flag introduced by this
feature, so nothing before this migration was ever archived.

No enum involved, so none of 001/002's enum-type-reuse handling applies.
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa

revision: str = "008"
down_revision: Union[str, None] = "007"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "generated_rotas",
        sa.Column("archived_at", sa.DateTime(timezone=True), nullable=True),
    )


def downgrade() -> None:
    op.drop_column("generated_rotas", "archived_at")