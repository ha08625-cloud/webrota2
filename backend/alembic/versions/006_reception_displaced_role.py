"""reception_rota_sessions.displaced_role

Revision ID: 006
Revises: 005
Create Date: 2026-08-18 00:00:00

Adds the nullable `displaced_role` column that the front-desk assigner uses to
remember the role it overwrote when it wrote `front_desk` onto a slot --
non-null means "the generator wrote this slot", which is what makes a re-run
idempotent and keeps hand-tagged `front_desk` slots safe from the reset step.
See the ReceptionRotaSession docstring in app/models/reception.py and
documentation/architecture-reception.md.

Only Postgres needs this: CI runs `alembic upgrade head` / `downgrade base`
against Postgres, while the test suite builds SQLite straight from the models
via `create_all`. The column reuses the *existing* `reception_role` native
type (`create_type=False`, the same trick 005 uses for `Day`), so it does not
try to CREATE TYPE a second time.

Downgrade drops the column; the recorded pre-assignment roles are not
recoverable afterwards, which is fine -- the system predates go-live, and the
roles on the day itself are unaffected either direction.
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

from app.models.enums import ReceptionRole, _snake

revision: str = "006"
down_revision: Union[str, None] = "005"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def _reception_role_type():
    name = _snake(ReceptionRole.__name__)
    values = lambda e: [m.value for m in e]  # noqa: E731
    if op.get_bind().dialect.name == "postgresql":
        return postgresql.ENUM(
            ReceptionRole, name=name, create_type=False, values_callable=values,
        )
    return sa.Enum(ReceptionRole, name=name, values_callable=values)


def upgrade() -> None:
    op.add_column(
        "reception_rota_sessions",
        sa.Column("displaced_role", _reception_role_type(), nullable=True),
    )


def downgrade() -> None:
    op.drop_column("reception_rota_sessions", "displaced_role")
