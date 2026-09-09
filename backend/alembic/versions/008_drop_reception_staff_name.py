"""drop reception_staff.name

Revision ID: 008
Revises: 007
Create Date: 2026-09-03 00:00:00

Reception staff had two identifiers, `code` and `name`, and nothing
structural distinguished them: every relation joins on `staff_id`, so
neither was ever a foreign key. `code` carried the unique constraint and was
what the grid row headers, sort orders and confirm prompts rendered, while
`name` appeared in three places and was duplicated onto the wire as
`staff_name`. The column is removed and `code` becomes the single
identifier, matching `doctors`, which has only a code. The frontend labels
the surviving field "Name"; the API and schema names are unchanged.

`batch_alter_table` is the project-wide rule for altering a column -- dev
SQLite cannot drop one in place.

Downgrade re-adds the column and backfills it from `code` rather than
leaving it empty: `name` was NOT NULL, and the original values are gone.
The system predates go-live, so no production data needs to survive either
direction.
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa

revision: str = "008"
down_revision: Union[str, None] = "007"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    with op.batch_alter_table("reception_staff") as batch_op:
        batch_op.drop_column("name")


def downgrade() -> None:
    with op.batch_alter_table("reception_staff") as batch_op:
        batch_op.add_column(sa.Column("name", sa.String(), nullable=True))
    op.execute(sa.text("UPDATE reception_staff SET name = code"))
    with op.batch_alter_table("reception_staff") as batch_op:
        batch_op.alter_column("name", existing_type=sa.String(), nullable=False)
