"""add practice_closures and rota_closures (M5 bank-holiday weeks)

Revision ID: 004
Revises: 003
Create Date: 2026-07-13 00:00:00

Two new tables, additive only. No enums involved, so none of 001/002's
enum-type-reuse handling applies.

practice_closures is global planning data (date unique, optional name).
rota_closures snapshots which closures applied to a given rota at
generation time, unique on (rota_id, date) -- mirrors the counter-snapshot
tables' rota_id FK + index pattern from 001. Deleting a GeneratedRota
cascades to its RotaClosure rows at the ORM level (relationship
cascade="all, delete-orphan"), the same mechanism already used for
RotaSession -- there is no DB-level ON DELETE CASCADE anywhere in this
schema, so downgrade() drops rota_closures before generated_rotas would
ever be touched, and upgrade() creates it after generated_rotas exists.
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa

revision: str = "004"
down_revision: Union[str, None] = "003"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "practice_closures",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("date", sa.Date(), nullable=False),
        sa.Column("name", sa.String(), nullable=True),
        sa.UniqueConstraint("date", name="uq_practice_closures_date"),
    )
    op.create_table(
        "rota_closures",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column(
            "rota_id", sa.Integer(),
            sa.ForeignKey("generated_rotas.id"), nullable=False,
        ),
        sa.Column("date", sa.Date(), nullable=False),
        sa.UniqueConstraint("rota_id", "date", name="uq_rota_closure_date"),
    )
    op.create_index(
        "ix_rota_closures_rota_id", "rota_closures", ["rota_id"],
    )


def downgrade() -> None:
    op.drop_table("rota_closures")
    op.drop_table("practice_closures")