"""extra session compensation (TOIL or payment)

Revision ID: 021
Revises: 020
Create Date: 2026-09-16 00:00:00

Adds `extra_session_entries.compensation`, recording how the practice
compensates a doctor for an extra session: time off in lieu, or payment.
Until now that decision lived outside the app entirely.

The column is NOT NULL with a server default of "Payment", so every row
that already exists reads as Payment. That is the point rather than a
convenience. A TOIL extra session credits +1 session to that doctor's leave
entitlement for the calendar year, counted at read time from this table, so
any other choice of default would retrospectively move historical leave
balances: a nullable "not yet decided" state would light up every old row
as an unresolved to-do, and defaulting to TOIL would hand out leave nobody
earned. Nothing was ever credited as TOIL before this migration, so
"Payment everywhere" is the only backfill that leaves every past balance
exactly as it stands. A row that should have been TOIL is corrected by
editing it.

`extra_session_compensation` is a new native enum type on Postgres, so this
follows 001's `_enum()` / `_create_enum_types()` pattern (as 017 does): the
type is created once, explicitly, at the top of upgrade(), and the column
references it without re-emitting CREATE TYPE. On SQLite `_enum()` falls
through to plain `sa.Enum` (VARCHAR + CHECK). The type name comes from
`_snake()` rather than a hard-coded string, so it cannot drift from what
`enum_col` renders for the models.

No `batch_alter_table`: SQLite can add a column in place, and 020's batch
usage was for altering a *constraint*, which this does not do. Non-nullable
and defaulted in one step, since there is no intermediate null state to
backfill separately.

Downgrade drops the column and then the enum type, which dropping a column
does not do on its own. CI round-trips the chain against Postgres 16 in
both directions, so a left-behind type fails the build.
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

from app.models.enums import ExtraSessionCompensation, _snake

revision: str = "021"
down_revision: Union[str, None] = "020"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

_NEW_ENUMS = (ExtraSessionCompensation,)


def _values(py_enum):
    return [member.value for member in py_enum]


def _enum(py_enum):
    """Column type for a Python enum, matching 001's helper.

    On Postgres the named type is created once by `_create_enum_types`
    below, so the column must reference it without re-emitting CREATE TYPE.
    """
    name = _snake(py_enum.__name__)
    if op.get_bind().dialect.name == "postgresql":
        return postgresql.ENUM(
            py_enum, name=name, create_type=False, values_callable=_values
        )
    return sa.Enum(py_enum, name=name, values_callable=_values)


def _create_enum_types() -> None:
    bind = op.get_bind()
    if bind.dialect.name != "postgresql":
        return
    for py_enum in _NEW_ENUMS:
        postgresql.ENUM(
            py_enum, name=_snake(py_enum.__name__), values_callable=_values
        ).create(bind, checkfirst=True)


def _drop_enum_types() -> None:
    bind = op.get_bind()
    if bind.dialect.name != "postgresql":
        return
    for py_enum in _NEW_ENUMS:
        postgresql.ENUM(
            py_enum, name=_snake(py_enum.__name__), values_callable=_values
        ).drop(bind, checkfirst=True)


def upgrade() -> None:
    _create_enum_types()

    op.add_column(
        "extra_session_entries",
        sa.Column(
            "compensation",
            _enum(ExtraSessionCompensation),
            nullable=False,
            server_default=ExtraSessionCompensation.PAYMENT.value,
        ),
    )


def downgrade() -> None:
    op.drop_column("extra_session_entries", "compensation")
    _drop_enum_types()
