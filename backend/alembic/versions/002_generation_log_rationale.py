"""generation log rationale

Revision ID: 002
Revises: 001
Create Date: 2026-08-15 00:00:00

Adds `rota_generation_log.rationale`: the stage-by-stage "why" behind each
logged decision (the candidates compared, what ruled the rest out, and
which stage decided), alongside the existing one-line `message` that says
what happened. See `app/engine/rationale.py`.

Nullable with no backfill: a decision that involved no choice has nothing
to explain, and rows written before this column existed cannot have one
reconstructed -- the log is never re-derived after generation.
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa

revision: str = "002"
down_revision: Union[str, None] = "001"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "rota_generation_log",
        sa.Column("rationale", sa.Text(), nullable=True),
    )


def downgrade() -> None:
    op.drop_column("rota_generation_log", "rationale")
