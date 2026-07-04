"""initial schema (all 18 tables)

Revision ID: 001
Revises:
Create Date: 2026-01-01 00:00:00

Hand-authored to mirror app.models. Per the M1 plan, this single migration
was regenerated/overwritten as the schema evolved through M1-M2. This M3
regeneration folds in the two counter-snapshot tables (per the finalised M3
plan, resolution 1: no separate 002/003 while nothing is deployed) and is the
version finalised as the deployment baseline on Railway + Postgres. Migrations
become additive only from here.

Postgres enum handling (M1 implementation note, resolved here): every native
enum type is created explicitly, once, with checkfirst at the top of
upgrade(); columns then reference the types without re-creating them
(postgresql.ENUM(create_type=False) on Postgres, plain sa.Enum on SQLite).
This avoids "type already exists" failures when the same enum is used across
multiple tables.

Clinic counters are shared-only (one row per doctor per clinic type). An
earlier per_slot design (ClinicCounterMode, ClinicCounter.day/period) was
reversed before M2 and never shipped to a persistent database, so it is
removed here rather than carried forward as a migration.
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

from app.models.enums import (
    Day,
    DoctorType,
    DutyType,
    MasterSessionType,
    Period,
    RoomType,
    RotaStatus,
    SessionRole,
    Site,
    SystemCounterType,
    _snake,
)

revision: str = "001"
down_revision: Union[str, None] = None
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


_ALL_ENUMS = (
    RoomType, Site, DoctorType, Day, Period, DutyType,
    RotaStatus, SystemCounterType, MasterSessionType, SessionRole,
)


def _values(py_enum):
    return [member.value for member in py_enum]


def _enum(py_enum):
    """Column type for a Python enum, safe to repeat across tables.

    On Postgres, returns a type that does NOT emit CREATE TYPE (the types are
    created once, explicitly, in _create_enum_types). Elsewhere (SQLite),
    returns a fresh generic sa.Enum, which renders VARCHAR + CHECK.
    """
    name = _snake(py_enum.__name__)
    if op.get_bind().dialect.name == "postgresql":
        return postgresql.ENUM(
            py_enum, name=name, create_type=False,
            values_callable=_values,
        )
    return sa.Enum(py_enum, name=name, values_callable=_values)


def _create_enum_types() -> None:
    bind = op.get_bind()
    if bind.dialect.name != "postgresql":
        return
    for py_enum in _ALL_ENUMS:
        postgresql.ENUM(
            py_enum, name=_snake(py_enum.__name__), values_callable=_values,
        ).create(bind, checkfirst=True)


def _drop_enum_types() -> None:
    bind = op.get_bind()
    if bind.dialect.name != "postgresql":
        return
    for py_enum in _ALL_ENUMS:
        postgresql.ENUM(
            py_enum, name=_snake(py_enum.__name__), values_callable=_values,
        ).drop(bind, checkfirst=True)


def upgrade() -> None:
    _create_enum_types()

    # --- root tables (no FKs) ---
    op.create_table(
        "rooms",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("code", sa.String(), nullable=False),
        sa.Column("room_type", _enum(RoomType), nullable=False),
        sa.Column("site", _enum(Site), nullable=False),
        sa.UniqueConstraint("code", name="uq_rooms_code"),
    )
    op.create_table(
        "doctors",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("code", sa.String(), nullable=False),
        sa.Column("doctor_type", _enum(DoctorType), nullable=False),
        sa.Column("sessions_per_week", sa.Numeric(4, 1), nullable=False),
        sa.Column("active", sa.Boolean(), nullable=False),
        sa.UniqueConstraint("code", name="uq_doctors_code"),
    )
    op.create_table(
        "clinic_types",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("name", sa.String(), nullable=False),
        sa.Column("clinic_priority", sa.Integer(), nullable=False),
        sa.Column("is_enabled", sa.Boolean(), nullable=False),
        sa.Column("category", sa.String(), nullable=True),
        sa.Column("room_required", sa.Boolean(), nullable=False),
        sa.UniqueConstraint("name", name="uq_clinic_types_name"),
    )
    op.create_table(
        "master_rota_templates",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("name", sa.String(), nullable=False),
        sa.Column("is_active", sa.Boolean(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
    )
    op.create_table(
        "rota_configs",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("start_date", sa.Date(), nullable=False),
        sa.Column("num_weeks", sa.Integer(), nullable=False),
        sa.Column("template_start_week", sa.Integer(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.CheckConstraint("num_weeks IN (1, 2, 4)", name="ck_config_num_weeks"),
        sa.CheckConstraint(
            "template_start_week BETWEEN 1 AND 4",
            name="ck_config_template_start_week",
        ),
    )

    # --- dependent tables ---
    op.create_table(
        "doctor_preferred_rooms",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("doctor_id", sa.Integer(), sa.ForeignKey("doctors.id"), nullable=False),
        sa.Column("preference_order", sa.Integer(), nullable=False),
        sa.Column("room_id", sa.Integer(), sa.ForeignKey("rooms.id"), nullable=True),
        sa.Column("room_type", _enum(RoomType), nullable=True),
        sa.CheckConstraint(
            "(CASE WHEN room_id IS NULL THEN 0 ELSE 1 END) "
            "+ (CASE WHEN room_type IS NULL THEN 0 ELSE 1 END) = 1",
            name="ck_dpr_room_xor",
        ),
        sa.UniqueConstraint("doctor_id", "preference_order", name="uq_dpr_doctor_order"),
    )
    op.create_table(
        "clinic_type_schedules",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column(
            "clinic_type_id", sa.Integer(),
            sa.ForeignKey("clinic_types.id"), nullable=False,
        ),
        sa.Column("day", _enum(Day), nullable=False),
        sa.Column("period", _enum(Period), nullable=False),
        sa.UniqueConstraint("clinic_type_id", "day", "period", name="uq_cts_slot"),
    )
    op.create_table(
        "clinic_type_doctor_eligibilities",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column(
            "clinic_type_id", sa.Integer(),
            sa.ForeignKey("clinic_types.id"), nullable=False,
        ),
        sa.Column("doctor_id", sa.Integer(), sa.ForeignKey("doctors.id"), nullable=False),
        sa.Column("doctor_priority", sa.Integer(), nullable=False),
        sa.UniqueConstraint("clinic_type_id", "doctor_id", name="uq_ctde_doctor"),
    )
    op.create_table(
        "clinic_type_room_eligibilities",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column(
            "clinic_type_id", sa.Integer(),
            sa.ForeignKey("clinic_types.id"), nullable=False,
        ),
        sa.Column("room_id", sa.Integer(), sa.ForeignKey("rooms.id"), nullable=True),
        sa.Column("room_type", _enum(RoomType), nullable=True),
        sa.CheckConstraint(
            "(CASE WHEN room_id IS NULL THEN 0 ELSE 1 END) "
            "+ (CASE WHEN room_type IS NULL THEN 0 ELSE 1 END) = 1",
            name="ck_ctre_room_xor",
        ),
        sa.UniqueConstraint("clinic_type_id", "room_id", name="uq_ctre_room_id"),
        sa.UniqueConstraint("clinic_type_id", "room_type", name="uq_ctre_room_type"),
    )
    op.create_table(
        "clinic_counters",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("doctor_id", sa.Integer(), sa.ForeignKey("doctors.id"), nullable=False),
        sa.Column(
            "clinic_type_id", sa.Integer(),
            sa.ForeignKey("clinic_types.id"), nullable=False,
        ),
        sa.Column("raw_count", sa.Integer(), nullable=False),
        sa.UniqueConstraint("doctor_id", "clinic_type_id", name="uq_clinic_counter"),
    )
    op.create_table(
        "system_counters",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("doctor_id", sa.Integer(), sa.ForeignKey("doctors.id"), nullable=False),
        sa.Column("counter_type", _enum(SystemCounterType), nullable=False),
        sa.Column("raw_count", sa.Integer(), nullable=False),
        sa.UniqueConstraint("doctor_id", "counter_type", name="uq_system_counter"),
    )
    op.create_table(
        "leave_entries",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("doctor_id", sa.Integer(), sa.ForeignKey("doctors.id"), nullable=False),
        sa.Column("date", sa.Date(), nullable=False),
        sa.Column("period", _enum(Period), nullable=False),
        sa.UniqueConstraint("doctor_id", "date", "period", name="uq_leave_slot"),
    )
    op.create_table(
        "duty_assignments",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("date", sa.Date(), nullable=False),
        sa.Column("period", _enum(Period), nullable=False),
        sa.Column("doctor_id", sa.Integer(), sa.ForeignKey("doctors.id"), nullable=False),
        sa.Column("duty_type", _enum(DutyType), nullable=False),
        sa.UniqueConstraint("date", "period", "duty_type", name="uq_duty_slot"),
    )
    op.create_table(
        "master_rota_sessions",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column(
            "template_id", sa.Integer(),
            sa.ForeignKey("master_rota_templates.id"), nullable=False,
        ),
        sa.Column("doctor_id", sa.Integer(), sa.ForeignKey("doctors.id"), nullable=False),
        sa.Column("week", sa.Integer(), nullable=False),
        sa.Column("day", _enum(Day), nullable=False),
        sa.Column("period", _enum(Period), nullable=False),
        sa.Column("session_type", _enum(MasterSessionType), nullable=False),
        sa.Column("room_id", sa.Integer(), sa.ForeignKey("rooms.id"), nullable=True),
        sa.CheckConstraint("week BETWEEN 1 AND 4", name="ck_mrs_week"),
        sa.UniqueConstraint(
            "template_id", "doctor_id", "week", "day", "period", name="uq_mrs_slot"
        ),
    )
    op.create_table(
        "generated_rotas",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column(
            "config_id", sa.Integer(),
            sa.ForeignKey("rota_configs.id"), nullable=False,
        ),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("status", _enum(RotaStatus), nullable=False),
    )
    op.create_table(
        "rota_sessions",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column(
            "rota_id", sa.Integer(),
            sa.ForeignKey("generated_rotas.id"), nullable=False,
        ),
        sa.Column("doctor_id", sa.Integer(), sa.ForeignKey("doctors.id"), nullable=False),
        sa.Column("week", sa.Integer(), nullable=False),
        sa.Column("day", _enum(Day), nullable=False),
        sa.Column("period", _enum(Period), nullable=False),
        sa.Column("room_id", sa.Integer(), sa.ForeignKey("rooms.id"), nullable=True),
        sa.Column(
            "clinic_type_id", sa.Integer(),
            sa.ForeignKey("clinic_types.id"), nullable=True,
        ),
        sa.Column("role", _enum(SessionRole), nullable=True),
        sa.Column("is_wfh", sa.Boolean(), nullable=False),
        sa.Column("notes", sa.Text(), nullable=True),
        sa.UniqueConstraint(
            "rota_id", "doctor_id", "week", "day", "period",
            name="uq_rota_session_slot",
        ),
    )
    # --- counter snapshot tables (M3 lifecycle) ---
    op.create_table(
        "rota_clinic_counter_snapshots",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column(
            "rota_id", sa.Integer(),
            sa.ForeignKey("generated_rotas.id"), nullable=False,
        ),
        sa.Column("doctor_id", sa.Integer(), sa.ForeignKey("doctors.id"), nullable=False),
        sa.Column(
            "clinic_type_id", sa.Integer(),
            sa.ForeignKey("clinic_types.id"), nullable=False,
        ),
        sa.Column("value_before", sa.Integer(), nullable=False),
    )
    op.create_index(
        "ix_rota_clinic_counter_snapshots_rota_id",
        "rota_clinic_counter_snapshots", ["rota_id"],
    )
    op.create_table(
        "rota_system_counter_snapshots",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column(
            "rota_id", sa.Integer(),
            sa.ForeignKey("generated_rotas.id"), nullable=False,
        ),
        sa.Column("doctor_id", sa.Integer(), sa.ForeignKey("doctors.id"), nullable=False),
        sa.Column("counter_type", _enum(SystemCounterType), nullable=False),
        sa.Column("value_before", sa.Integer(), nullable=False),
    )
    op.create_index(
        "ix_rota_system_counter_snapshots_rota_id",
        "rota_system_counter_snapshots", ["rota_id"],
    )


def downgrade() -> None:
    for table in (
        "rota_system_counter_snapshots",
        "rota_clinic_counter_snapshots",
        "rota_sessions",
        "generated_rotas",
        "master_rota_sessions",
        "duty_assignments",
        "leave_entries",
        "system_counters",
        "clinic_counters",
        "clinic_type_room_eligibilities",
        "clinic_type_doctor_eligibilities",
        "clinic_type_schedules",
        "doctor_preferred_rooms",
        "rota_configs",
        "master_rota_templates",
        "clinic_types",
        "doctors",
        "rooms",
    ):
        op.drop_table(table)
    _drop_enum_types()
