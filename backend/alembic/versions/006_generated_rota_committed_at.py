"""add GeneratedRota.committed_at (rollback-of-commits support)

Revision ID: 006
Revises: 005
Create Date: 2026-07-14 00:00:00

Adds a single nullable DateTime column, no backfill and no server_default
-- matching 002's template_type pattern rather than 003's is_supervising
pattern, because null has a defined, permanent meaning here rather than
being a temporary backfill gap.

Existing committed rotas (any environment) read as committed_at = NULL.
Per the rollback-of-committed-rotas plan (Decision 3), NULL is a hard
block on rollback, not "rollback from the beginning of time": those rows
had their counter snapshots deleted at commit time under the pre-006
lifecycle, so there is nothing to restore from and rollback_commit() must
refuse them. This is intentional and requires no data migration --
correctness comes from rollback_commit()'s guard, not from backfilling a
value here.

No enum involved, so none of 001/002's enum-type-reuse handling applies.
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa

revision: str = "006"
down_revision: Union[str, None] = "005"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "generated_rotas",
        sa.Column("committed_at", sa.DateTime(timezone=True), nullable=True),
    )


def downgrade() -> None:
    op.drop_column("generated_rotas", "committed_at")