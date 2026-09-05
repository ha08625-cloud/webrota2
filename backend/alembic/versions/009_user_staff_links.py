"""users.doctor_id / users.reception_staff_id

Revision ID: 009
Revises: 008
Create Date: 2026-09-05 00:00:00

Adds the optional link from a login to the person it belongs to on each
rota. Until now `users` and the two staff tables were entirely unrelated:
the app knew a request came from a given user, but not which row on the
clinical or reception rota was theirs. See app/models/user.py's docstring
for why the columns sit on `users` rather than on `doctors` /
`reception_staff`, and why they are two typed foreign keys rather than one
polymorphic pair.

Both columns are nullable and there is no backfill: every existing row is
legitimately unlinked, and the link is chosen by a manager, one person at a
time.

The adds go through `batch_alter_table` even though they are adds, not
alters: SQLite cannot ALTER TABLE ADD CONSTRAINT, so a plain
`op.add_column` carrying an inline ForeignKey dies on the dev database.
Batch mode's copy-and-move builds the new table with the constraints in
place, and is a plain ALTER on Postgres. The foreign keys are named
explicitly for the same reason the indexes are: batch mode has to be able
to refer to them by name to drop them.

Each column gets its own unique index, which is what gives the link its
0..1-on-both-sides shape: NULLs are distinct in a unique index on both
SQLite and Postgres, so any number of users may be unlinked while no two
can claim the same staff row. The indexes are named explicitly because the
downgrade drops them by name.

Only Postgres needs this migration: CI runs `alembic upgrade head` /
`downgrade base` against Postgres, while the test suite builds SQLite
straight from the models via `create_all`.

Downgrade drops both indexes and both columns; the links themselves are not
recoverable afterwards and would have to be re-chosen.
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa

revision: str = "009"
down_revision: Union[str, None] = "008"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    with op.batch_alter_table("users") as batch_op:
        batch_op.add_column(sa.Column("doctor_id", sa.Integer(), nullable=True))
        batch_op.add_column(
            sa.Column("reception_staff_id", sa.Integer(), nullable=True)
        )
        batch_op.create_foreign_key(
            "fk_users_doctor_id", "doctors", ["doctor_id"], ["id"]
        )
        batch_op.create_foreign_key(
            "fk_users_reception_staff_id",
            "reception_staff",
            ["reception_staff_id"],
            ["id"],
        )

    op.create_index("uq_users_doctor_id", "users", ["doctor_id"], unique=True)
    op.create_index(
        "uq_users_reception_staff_id", "users", ["reception_staff_id"], unique=True
    )


def downgrade() -> None:
    op.drop_index("uq_users_reception_staff_id", table_name="users")
    op.drop_index("uq_users_doctor_id", table_name="users")

    with op.batch_alter_table("users") as batch_op:
        batch_op.drop_constraint("fk_users_reception_staff_id", type_="foreignkey")
        batch_op.drop_constraint("fk_users_doctor_id", type_="foreignkey")
        batch_op.drop_column("reception_staff_id")
        batch_op.drop_column("doctor_id")
