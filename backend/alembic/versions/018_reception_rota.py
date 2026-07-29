"""add reception rota tables (staff, master template, rota, coverage rules)

Revision ID: 018
Revises: 017
Create Date: 2026-07-29 00:00:00

Reception rota Task 1: a second, independent rota type living entirely
alongside the clinical one. Five new tables (four data tables plus the new
`reception_role` enum type) and nothing else -- no existing table or code
path is touched.

This is the first migration since 001 to create a brand new Postgres enum
type. Every migration since (002, 011, 014, 015, 016) has reused an enum
type 001 already created, always with create_type=False. `reception_role`
has no such precedent to reuse, so it is created explicitly with
checkfirst=True at the top of upgrade(), mirroring 001's
_create_enum_types() pattern, and it is this migration's to drop in
downgrade() -- unlike 002/011's enum reuse, nothing else in the schema
references reception_role, so nothing else needs it to survive. The CI
Postgres round-trip (upgrade/downgrade/upgrade) therefore proves something
it has not had to prove since 001: that a fresh enum type is created,
dropped, and recreated cleanly, not just referenced.

`day` on reception_master_sessions and reception_coverage_rules reuses the
existing `day` enum type 001 created, via the same _enum_column() helper
011/014/015/016 all copy verbatim.

Table creation order: reception_staff, reception_master_sessions,
reception_rotas, reception_rota_sessions, reception_coverage_rules.
downgrade() reverses it. All five tables start empty (this is a new
feature with no prior data), so there is no backfill and no
server_default anywhere -- additive-only, the 011 pattern.
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

from app.models.enums import Day, ReceptionRole, _snake

revision: str = "018"
down_revision: Union[str, None] = "017"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def _values(py_enum):
    return [member.value for member in py_enum]


def _enum_column(name: str, py_enum, nullable: bool) -> sa.Column:
    """Copied verbatim from migration 016 (which copied 015, 014, 011): on
    Postgres, references the existing named enum type without recreating
    it; elsewhere (SQLite), a plain sa.Enum (renders VARCHAR + CHECK)."""
    type_name = _snake(py_enum.__name__)
    values = _values(py_enum)
    if op.get_bind().dialect.name == "postgresql":
        enum_type = postgresql.ENUM(
            py_enum, name=type_name, create_type=False, values_callable=lambda e: values,
        )
    else:
        enum_type = sa.Enum(py_enum, name=type_name, values_callable=lambda e: values)
    return sa.Column(name, enum_type, nullable=nullable)


def _reception_role_column(name: str, nullable: bool) -> sa.Column:
    """Unlike day/period, reception_role is a brand new enum type -- created
    explicitly below with checkfirst, not reused from 001 -- so on Postgres
    this still references it with create_type=False (the type already
    exists by the time any table is created). No server_default: the
    ReceptionRole.PHONES default on the model is a Python-side ORM default
    (mirroring MasterRotaTemplate.is_active's pattern in 001), not a DB
    default, so it is not repeated here."""
    type_name = _snake(ReceptionRole.__name__)
    values = _values(ReceptionRole)
    if op.get_bind().dialect.name == "postgresql":
        enum_type = postgresql.ENUM(
            ReceptionRole, name=type_name, create_type=False,
            values_callable=lambda e: values,
        )
    else:
        enum_type = sa.Enum(ReceptionRole, name=type_name, values_callable=lambda e: values)
    return sa.Column(name, enum_type, nullable=nullable)


def _create_reception_role_type() -> None:
    bind = op.get_bind()
    if bind.dialect.name != "postgresql":
        return
    postgresql.ENUM(
        ReceptionRole, name=_snake(ReceptionRole.__name__), values_callable=_values,
    ).create(bind, checkfirst=True)


def _drop_reception_role_type() -> None:
    bind = op.get_bind()
    if bind.dialect.name != "postgresql":
        return
    postgresql.ENUM(
        ReceptionRole, name=_snake(ReceptionRole.__name__), values_callable=_values,
    ).drop(bind, checkfirst=True)


def upgrade() -> None:
    _create_reception_role_type()

    op.create_table(
        "reception_staff",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("code", sa.String(), nullable=False),
        sa.Column("name", sa.String(), nullable=False),
        sa.Column("active", sa.Boolean(), nullable=False),
        sa.UniqueConstraint("code", name="uq_reception_staff_code"),
    )

    op.create_table(
        "reception_master_sessions",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column(
            "staff_id", sa.Integer(),
            sa.ForeignKey("reception_staff.id"), nullable=False,
        ),
        _enum_column("day", Day, nullable=False),
        sa.Column("hour", sa.Integer(), nullable=False),
        _reception_role_column("role", nullable=False),
        sa.Column("note", sa.String(length=200), nullable=True),
        sa.CheckConstraint("hour BETWEEN 8 AND 17", name="ck_rms_hour"),
        sa.UniqueConstraint("staff_id", "day", "hour", name="uq_rms_slot"),
    )

    op.create_table(
        "reception_rotas",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("date", sa.Date(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.UniqueConstraint("date", name="uq_reception_rotas_date"),
    )

    op.create_table(
        "reception_rota_sessions",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column(
            "rota_id", sa.Integer(),
            sa.ForeignKey("reception_rotas.id"), nullable=False,
        ),
        sa.Column(
            "staff_id", sa.Integer(),
            sa.ForeignKey("reception_staff.id"), nullable=False,
        ),
        sa.Column("hour", sa.Integer(), nullable=False),
        _reception_role_column("role", nullable=False),
        sa.Column("note", sa.String(length=200), nullable=True),
        sa.CheckConstraint("hour BETWEEN 8 AND 17", name="ck_rrs_hour"),
        sa.UniqueConstraint("rota_id", "staff_id", "hour", name="uq_rrs_slot"),
    )

    op.create_table(
        "reception_coverage_rules",
        sa.Column("id", sa.Integer(), primary_key=True),
        _enum_column("day", Day, nullable=False),
        sa.Column("hour", sa.Integer(), nullable=False),
        sa.Column("min_phones_staff", sa.Integer(), nullable=False),
        sa.CheckConstraint("hour BETWEEN 8 AND 17", name="ck_rcr_hour"),
        sa.UniqueConstraint("day", "hour", name="uq_rcr_slot"),
    )


def downgrade() -> None:
    op.drop_table("reception_coverage_rules")
    op.drop_table("reception_rota_sessions")
    op.drop_table("reception_rotas")
    op.drop_table("reception_master_sessions")
    op.drop_table("reception_staff")

    _drop_reception_role_type()
