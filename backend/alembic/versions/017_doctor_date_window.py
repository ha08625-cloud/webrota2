"""add Doctor.start_date / Doctor.end_date (employment window)

Revision ID: 017
Revises: 016
Create Date: 2026-07-28 00:00:00

Annual leave planning (Task 1): a doctor gains an optional employment
window so joiners and leavers can be entered ahead of time. Two nullable
Date columns, no backfill and no server_default -- the 006/008 pattern,
because null has a defined, permanent meaning here ("unbounded at this
end") rather than being a temporary backfill gap. Every existing row
therefore reads as unbounded at both ends, which is exactly the current
behaviour.

No ordering check constraint: the start <= end pairing is enforced at the
API boundary (routers/doctors.py), so a PATCH that sets one end before
the other does not have to satisfy the pair mid-request.

No enum involved, so none of 001/002's enum-type-reuse handling applies,
and neither does the `_enum_column` helper 011/014/015/016 share.
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa

revision: str = "017"
down_revision: Union[str, None] = "016"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column("doctors", sa.Column("start_date", sa.Date(), nullable=True))
    op.add_column("doctors", sa.Column("end_date", sa.Date(), nullable=True))


def downgrade() -> None:
    op.drop_column("doctors", "end_date")
    op.drop_column("doctors", "start_date")
