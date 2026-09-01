"""doctors.calendar_token

Revision ID: 007
Revises: 006
Create Date: 2026-09-01 00:00:00

Adds the per-doctor secret that identifies a doctor's public .ics calendar
feed (documentation/calendar_feed_plan.md, Decisions 2 and 3). The column is
NOT NULL with no server default, which is the point: there is no single value
the existing rows could share, so the invariant "every doctor row has a token
from creation" is established here, per row, rather than left to a separate
backfill script. The feed route can therefore look a token up through the
unique index without a null branch.

The three steps are add-nullable, backfill a distinct
`secrets.token_urlsafe(32)` per row in Python, then batch-alter to NOT NULL.
The backfill is per-row deliberately: no portable SQL expression produces a
distinct random urlsafe token per row across SQLite and Postgres, and the row
count here is dozens. `batch_alter_table` is the project-wide rule for
altering a column -- dev SQLite cannot alter in place.

Only Postgres needs this migration: CI runs `alembic upgrade head` /
`downgrade base` against Postgres, while the test suite builds SQLite
straight from the models via `create_all`.

Downgrade drops the index and the column. The tokens are NOT recoverable
afterwards, so a downgrade-then-upgrade issues fresh ones and every
subscriber's calendar silently stops updating until they re-subscribe.
"""
import secrets
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa

revision: str = "007"
down_revision: Union[str, None] = "006"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column("doctors", sa.Column("calendar_token", sa.String(), nullable=True))

    bind = op.get_bind()
    doctor_ids = bind.execute(sa.text("SELECT id FROM doctors")).scalars().all()
    for doctor_id in doctor_ids:
        bind.execute(
            sa.text("UPDATE doctors SET calendar_token = :token WHERE id = :id"),
            {"token": secrets.token_urlsafe(32), "id": doctor_id},
        )

    with op.batch_alter_table("doctors") as batch_op:
        batch_op.alter_column("calendar_token", existing_type=sa.String(), nullable=False)

    op.create_index(
        "ix_doctors_calendar_token", "doctors", ["calendar_token"], unique=True
    )


def downgrade() -> None:
    op.drop_index("ix_doctors_calendar_token", table_name="doctors")
    op.drop_column("doctors", "calendar_token")
