"""add doctor_signatures (signatures feature, Task 1)

Revision ID: 009
Revises: 008
Create Date: 2026-07-18 00:00:00

One new table, additive only. No enums involved, so none of 001/002's
enum-type-reuse handling applies.

doctor_signatures holds one signature image per doctor: image bytes as
LargeBinary (bytea on Postgres), content_type ("image/jpeg" or
"image/png"), and uploaded_at (set by the router at write time, no
server_default -- see the model docstring). unique(doctor_id) enforces one
signature per doctor at the schema level, not just in the router -- see the
signatures feature plan, Decision 1. The unique constraint also serves as
the lookup index, so no separate op.create_index call is needed.
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa

revision: str = "009"
down_revision: Union[str, None] = "008"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "doctor_signatures",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column(
            "doctor_id", sa.Integer(),
            sa.ForeignKey("doctors.id"), nullable=False,
        ),
        sa.Column("image", sa.LargeBinary(), nullable=False),
        sa.Column("content_type", sa.String(), nullable=False),
        sa.Column("uploaded_at", sa.DateTime(timezone=True), nullable=False),
        sa.UniqueConstraint("doctor_id", name="uq_doctor_signatures_doctor_id"),
    )


def downgrade() -> None:
    op.drop_table("doctor_signatures")
