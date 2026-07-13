"""server-managed clinic_priority: normalize + partial unique index

Revision ID: 005
Revises: 004
Create Date: 2026-07-13 00:00:00

clinic_priority moves from a client-supplied field to a server-computed
contiguous 1..N ordering over enabled clinic types, maintained via the
reorder endpoint and small helpers in the router. This migration does two
things, in this order, and the order matters:

1. Normalize existing data. Priorities were previously client-supplied with
   no uniqueness guarantee (the old frontend default was 1000), so
   duplicates among enabled rows are likely in any populated environment
   and would make the index creation below fail. Enabled rows are
   renumbered to 1..N ordered by (clinic_priority, id) for determinism.
   Disabled rows are left untouched -- their stale value sits outside the
   partial index and is corrected the next time that row is re-enabled.
   This step is a no-op on an empty table (fresh CI databases, and any
   environment with no clinic types configured yet).

2. Create a partial unique index on clinic_priority, scoped to enabled rows
   only via a dialect-specific WHERE clause -- sqlite_where for the test
   suite, postgresql_where for Railway. Both are required; SQLite and
   Postgres do not share a single generic partial-index syntax through
   Alembic's op.create_index.

downgrade() drops the index only. The renumbering in step 1 is not
reversed -- the original client-supplied values are unrecoverable, and a
contiguous 1..N sequence is a valid state under the pre-migration schema
regardless.

No enum involved, so none of 001/002's enum-type-reuse handling applies.
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa

revision: str = "005"
down_revision: Union[str, None] = "004"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    bind = op.get_bind()

    clinic_types = sa.table(
        "clinic_types",
        sa.column("id", sa.Integer),
        sa.column("clinic_priority", sa.Integer),
        sa.column("is_enabled", sa.Boolean),
    )

    rows = bind.execute(
        sa.select(clinic_types.c.id, clinic_types.c.clinic_priority)
        .where(clinic_types.c.is_enabled.is_(True))
        .order_by(clinic_types.c.clinic_priority, clinic_types.c.id)
    ).fetchall()

    for new_priority, row in enumerate(rows, start=1):
        if row.clinic_priority != new_priority:
            bind.execute(
                clinic_types.update()
                .where(clinic_types.c.id == row.id)
                .values(clinic_priority=new_priority)
            )

    op.create_index(
        "uq_clinic_types_priority_enabled",
        "clinic_types",
        ["clinic_priority"],
        unique=True,
        sqlite_where=sa.text("is_enabled"),
        postgresql_where=sa.text("is_enabled"),
    )


def downgrade() -> None:
    op.drop_index("uq_clinic_types_priority_enabled", table_name="clinic_types")