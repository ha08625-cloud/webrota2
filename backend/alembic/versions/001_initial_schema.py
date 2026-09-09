"""initial schema (pre-go-live baseline)

Revision ID: 001
Revises:
Create Date: 2026-08-12 00:00:00

The single baseline for the whole schema: 40 tables, 13 Postgres enum types,
81 indexes (82 in pg_indexes, which also counts alembic_version's own primary
key). It replaces the 28-migration chain that accumulated while the
system was still pre-live; that chain built the same schema in 28 steps, six
of which existed only to backfill rows in a database that no longer exists.
Consolidating before go-live cost a reseed; after go-live it would have cost
a production data migration. Git history is the archive for the old chain --
this file is the description of the schema.

Migrations are additive from here. Nothing downstream may edit this file.

The schema is derived from app.models, which is the source of truth: every
column, constraint name and server default here matches what
Base.metadata.create_all() produces, so the test suite (which uses create_all)
and a migrated Postgres database agree. The one exception is physical column
ordering, which Postgres does not treat as semantically meaningful and which
this file does not attempt to preserve from the old chain's ALTER TABLE order.

Postgres enum handling: every native enum type is created explicitly, once,
with checkfirst at the top of upgrade(); columns then reference the types
without re-creating them (postgresql.ENUM(create_type=False) on Postgres,
plain sa.Enum on SQLite). This is required because most of these enums are
used by more than one table, and a per-column CREATE TYPE fails with "type
already exists" the second time. It is also why `alembic revision
--autogenerate` output cannot be used verbatim -- it emits the per-column
form, and its tables must be restructured onto the _enum() helper below.

No DB-level ON DELETE CASCADE exists anywhere in this schema except
school_holidays.school_id; every other parent/child cleanup is ORM-level
(relationship(cascade="all, delete-orphan")).
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

from app.models.enums import (
    AccessLevel,
    Day,
    DoctorType,
    DutyType,
    MasterSessionType,
    Period,
    ReceptionRole,
    RoomType,
    RotaStatus,
    SessionRole,
    Site,
    SupervisionPreference,
    SystemCounterType,
    _snake,
)

revision: str = "001"
down_revision: Union[str, None] = None
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


_ALL_ENUMS = (
    RoomType, Site, DoctorType, SupervisionPreference, Day, Period, DutyType,
    RotaStatus, SystemCounterType, MasterSessionType, SessionRole,
    ReceptionRole, AccessLevel,
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


# Every table, in creation (dependency) order. downgrade() drops the reverse.
_TABLES_IN_DEPENDENCY_ORDER = (
    # reference data (no foreign keys)
    "rooms",
    "doctors",
    "clinic_types",
    "master_rota_templates",
    "rota_configs",
    "practice_closures",
    "schools",
    "recurring_notes",
    "users",
    "reception_staff",
    "reception_coverage_rules",
    "reception_rotas",
    # clinical configuration
    "doctor_preferred_rooms",
    "doctor_signatures",
    "clinic_type_schedules",
    "clinic_type_doctor_eligibilities",
    "clinic_type_room_eligibilities",
    "clinic_counters",
    "system_counters",
    # planner inputs
    "leave_entries",
    "leave_entitlements",
    "extra_session_entries",
    "blocked_entries",
    "duty_assignments",
    "school_holidays",
    "recurring_note_doctors",
    "recurring_note_weeks",
    # master template
    "master_rota_sessions",
    # staging
    "rota_stagings",
    "rota_staging_sessions",
    # generated clinical rota
    "generated_rotas",
    "rota_sessions",
    "rota_closures",
    "rota_generation_log",
    "rota_clinic_counter_snapshots",
    "rota_system_counter_snapshots",
    # reception rota
    "reception_master_sessions",
    "reception_rota_sessions",
    "reception_leave_entries",
    # auth
    "sessions",
)


def upgrade() -> None:
    _create_enum_types()

    # --- reference data (no foreign keys) ---
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
        sa.Column(
            "supervision_preference", _enum(SupervisionPreference),
            server_default="normal", nullable=False,
        ),
        sa.Column("start_date", sa.Date(), nullable=True),
        sa.Column("end_date", sa.Date(), nullable=True),
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
    # clinic_priority is contiguous 1..N over *enabled* rows only; disabled
    # rows keep a stale value that sits outside this partial index.
    op.create_index(
        "uq_clinic_types_priority_enabled",
        "clinic_types", ["clinic_priority"], unique=True,
        sqlite_where=sa.text("is_enabled"),
        postgresql_where=sa.text("is_enabled"),
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
    op.create_table(
        "practice_closures",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("date", sa.Date(), nullable=False),
        sa.Column("period", _enum(Period), nullable=False),
        sa.Column("name", sa.String(), nullable=True),
        sa.Column("bank_holiday_key", sa.String(), nullable=True),
        sa.UniqueConstraint("date", "period", name="uq_practice_closure_slot"),
    )
    op.create_table(
        "schools",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("name", sa.String(), nullable=False),
        sa.UniqueConstraint("name", name="uq_school_name"),
    )
    op.create_table(
        "recurring_notes",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("text", sa.String(length=200), nullable=False),
        sa.Column("day", _enum(Day), nullable=False),
        sa.Column("period", _enum(Period), nullable=False),
        sa.Column(
            "is_active", sa.Boolean(),
            server_default=sa.text("true"), nullable=False,
        ),
    )
    op.create_table(
        "users",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("email", sa.String(), nullable=False),
        sa.Column("name", sa.String(), nullable=False),
        sa.Column("password_hash", sa.String(), nullable=False),
        sa.Column("active", sa.Boolean(), nullable=False),
        # Defaults to the lowest tier: an accidental viewer is recoverable,
        # an accidental manager is a silent security hole.
        sa.Column(
            "access_level", _enum(AccessLevel),
            server_default="nurse", nullable=False,
        ),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.UniqueConstraint("email", name="uq_users_email"),
    )
    op.create_table(
        "reception_staff",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("code", sa.String(), nullable=False),
        sa.Column("name", sa.String(), nullable=False),
        sa.Column("active", sa.Boolean(), nullable=False),
        sa.UniqueConstraint("code", name="uq_reception_staff_code"),
    )
    op.create_table(
        "reception_coverage_rules",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("day", _enum(Day), nullable=False),
        sa.Column("hour", sa.Float(), nullable=False),
        sa.Column("min_phones_staff", sa.Integer(), nullable=False),
        sa.CheckConstraint(
            "hour BETWEEN 7.5 AND 18.0 AND (hour * 2) = CAST(hour * 2 AS INTEGER)",
            name="ck_rcr_hour",
        ),
        sa.UniqueConstraint("day", "hour", name="uq_rcr_slot"),
    )
    op.create_table(
        "reception_rotas",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("date", sa.Date(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.UniqueConstraint("date", name="uq_reception_rotas_date"),
    )

    # --- clinical configuration ---
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
        "doctor_signatures",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("doctor_id", sa.Integer(), sa.ForeignKey("doctors.id"), nullable=False),
        sa.Column("image", sa.LargeBinary(), nullable=False),
        sa.Column("content_type", sa.String(), nullable=False),
        sa.Column("uploaded_at", sa.DateTime(timezone=True), nullable=False),
        sa.UniqueConstraint("doctor_id", name="uq_doctor_signatures_doctor_id"),
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

    # --- planner inputs ---
    op.create_table(
        "leave_entries",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("doctor_id", sa.Integer(), sa.ForeignKey("doctors.id"), nullable=False),
        sa.Column("date", sa.Date(), nullable=False),
        sa.Column("period", _enum(Period), nullable=False),
        sa.Column("notes", sa.String(length=12), nullable=True),
        sa.UniqueConstraint("doctor_id", "date", "period", name="uq_leave_slot"),
    )
    op.create_table(
        "leave_entitlements",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("doctor_id", sa.Integer(), sa.ForeignKey("doctors.id"), nullable=False),
        sa.Column("year", sa.Integer(), nullable=False),
        sa.Column("entitlement_sessions", sa.Numeric(5, 1), nullable=True),
        sa.Column(
            "carry_over_sessions", sa.Numeric(5, 1),
            server_default="0", nullable=False,
        ),
        sa.Column(
            "adjustment_sessions", sa.Numeric(5, 1),
            server_default="0", nullable=False,
        ),
        sa.Column("notes", sa.String(length=200), nullable=True),
        sa.UniqueConstraint(
            "doctor_id", "year", name="uq_leave_entitlement_doctor_year"
        ),
    )
    op.create_table(
        "extra_session_entries",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("doctor_id", sa.Integer(), sa.ForeignKey("doctors.id"), nullable=False),
        sa.Column("date", sa.Date(), nullable=False),
        sa.Column("period", _enum(Period), nullable=False),
        sa.Column("notes", sa.String(length=12), nullable=True),
        sa.UniqueConstraint(
            "doctor_id", "date", "period", name="uq_extra_session_slot"
        ),
    )
    op.create_table(
        "blocked_entries",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("doctor_id", sa.Integer(), sa.ForeignKey("doctors.id"), nullable=False),
        sa.Column("date", sa.Date(), nullable=False),
        sa.Column("period", _enum(Period), nullable=False),
        sa.Column("notes", sa.String(length=12), nullable=True),
        sa.UniqueConstraint("doctor_id", "date", "period", name="uq_blocked_slot"),
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
        "school_holidays",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column(
            "school_id", sa.Integer(),
            sa.ForeignKey("schools.id", ondelete="CASCADE"), nullable=False,
        ),
        sa.Column("start_date", sa.Date(), nullable=False),
        sa.Column("end_date", sa.Date(), nullable=False),
        sa.Column("name", sa.String(), nullable=True),
    )
    op.create_index(
        "ix_school_holidays_school_id", "school_holidays", ["school_id"],
    )
    op.create_table(
        "recurring_note_doctors",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column(
            "note_id", sa.Integer(),
            sa.ForeignKey("recurring_notes.id"), nullable=False,
        ),
        sa.Column("doctor_id", sa.Integer(), sa.ForeignKey("doctors.id"), nullable=False),
        sa.UniqueConstraint("note_id", "doctor_id", name="uq_rnd_note_doctor"),
    )
    op.create_table(
        "recurring_note_weeks",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column(
            "note_id", sa.Integer(),
            sa.ForeignKey("recurring_notes.id"), nullable=False,
        ),
        sa.Column("template_week", sa.Integer(), nullable=False),
        sa.CheckConstraint("template_week BETWEEN 1 AND 4", name="ck_rnw_week"),
        sa.UniqueConstraint("note_id", "template_week", name="uq_rnw_note_week"),
    )

    # --- master template ---
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

    # --- staging (the editable copy of the template a rota is built from) ---
    op.create_table(
        "rota_stagings",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column(
            "config_id", sa.Integer(),
            sa.ForeignKey("rota_configs.id"), nullable=False,
        ),
        sa.Column(
            "source_template_id", sa.Integer(),
            sa.ForeignKey("master_rota_templates.id"), nullable=False,
        ),
        sa.Column(
            "source_template_start_week", sa.Integer(),
            server_default="1", nullable=False,
        ),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("completed_at", sa.DateTime(timezone=True), nullable=True),
        sa.UniqueConstraint("config_id", name="uq_rota_stagings_config_id"),
    )
    op.create_table(
        "rota_staging_sessions",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column(
            "staging_id", sa.Integer(),
            sa.ForeignKey("rota_stagings.id"), nullable=False,
        ),
        sa.Column("doctor_id", sa.Integer(), sa.ForeignKey("doctors.id"), nullable=False),
        sa.Column("week", sa.Integer(), nullable=False),
        sa.Column("day", _enum(Day), nullable=False),
        sa.Column("period", _enum(Period), nullable=False),
        sa.Column("session_type", _enum(MasterSessionType), nullable=False),
        sa.Column("room_id", sa.Integer(), sa.ForeignKey("rooms.id"), nullable=True),
        sa.CheckConstraint("week BETWEEN 1 AND 4", name="ck_rss_week"),
        sa.UniqueConstraint(
            "staging_id", "doctor_id", "week", "day", "period", name="uq_rss_slot"
        ),
    )

    # --- generated clinical rota ---
    op.create_table(
        "generated_rotas",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column(
            "config_id", sa.Integer(),
            sa.ForeignKey("rota_configs.id"), nullable=False,
        ),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("status", _enum(RotaStatus), nullable=False),
        sa.Column("committed_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("archived_at", sa.DateTime(timezone=True), nullable=True),
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
        sa.Column("template_type", _enum(MasterSessionType), nullable=True),
        sa.Column("is_wfh", sa.Boolean(), nullable=False),
        sa.Column("notes", sa.Text(), nullable=True),
        sa.Column(
            "is_supervising", sa.Boolean(),
            server_default=sa.text("false"), nullable=False,
        ),
        sa.UniqueConstraint(
            "rota_id", "doctor_id", "week", "day", "period",
            name="uq_rota_session_slot",
        ),
    )
    op.create_table(
        "rota_closures",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column(
            "rota_id", sa.Integer(),
            sa.ForeignKey("generated_rotas.id"), nullable=False,
        ),
        sa.Column("date", sa.Date(), nullable=False),
        sa.Column("period", _enum(Period), nullable=False),
        sa.UniqueConstraint("rota_id", "date", "period", name="uq_rota_closure_slot"),
    )
    op.create_index("ix_rota_closures_rota_id", "rota_closures", ["rota_id"])
    op.create_table(
        "rota_generation_log",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column(
            "rota_id", sa.Integer(),
            sa.ForeignKey("generated_rotas.id"), nullable=False,
        ),
        sa.Column("sequence", sa.Integer(), nullable=False),
        sa.Column("phase", sa.String(length=20), nullable=False),
        sa.Column("action", sa.String(length=40), nullable=False),
        sa.Column("week", sa.Integer(), nullable=True),
        sa.Column("day", _enum(Day), nullable=True),
        sa.Column("period", _enum(Period), nullable=True),
        sa.Column("doctor_id", sa.Integer(), nullable=True),
        sa.Column("related_doctor_id", sa.Integer(), nullable=True),
        sa.Column("room_id", sa.Integer(), nullable=True),
        sa.Column("related_room_id", sa.Integer(), nullable=True),
        sa.Column("clinic_type_id", sa.Integer(), nullable=True),
        sa.Column("message", sa.Text(), nullable=False),
        sa.UniqueConstraint("rota_id", "sequence", name="uq_rota_log_sequence"),
    )
    op.create_index(
        "ix_rota_generation_log_rota_id", "rota_generation_log", ["rota_id"],
    )
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

    # --- reception rota (half-hourly slots, 07:30-18:30) ---
    op.create_table(
        "reception_master_sessions",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column(
            "staff_id", sa.Integer(),
            sa.ForeignKey("reception_staff.id"), nullable=False,
        ),
        sa.Column("day", _enum(Day), nullable=False),
        sa.Column("hour", sa.Float(), nullable=False),
        sa.Column("role", _enum(ReceptionRole), nullable=False),
        sa.Column("note", sa.String(length=200), nullable=True),
        sa.CheckConstraint(
            "hour BETWEEN 7.5 AND 18.0 AND (hour * 2) = CAST(hour * 2 AS INTEGER)",
            name="ck_rms_hour",
        ),
        sa.UniqueConstraint("staff_id", "day", "hour", name="uq_rms_slot"),
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
        sa.Column("hour", sa.Float(), nullable=False),
        sa.Column("role", _enum(ReceptionRole), nullable=False),
        sa.Column("note", sa.String(length=200), nullable=True),
        sa.CheckConstraint(
            "hour BETWEEN 7.5 AND 18.0 AND (hour * 2) = CAST(hour * 2 AS INTEGER)",
            name="ck_rrs_hour",
        ),
        sa.UniqueConstraint("rota_id", "staff_id", "hour", name="uq_rrs_slot"),
    )
    op.create_table(
        "reception_leave_entries",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column(
            "staff_id", sa.Integer(),
            sa.ForeignKey("reception_staff.id"), nullable=False,
        ),
        sa.Column("date", sa.Date(), nullable=False),
        sa.UniqueConstraint("staff_id", "date", name="uq_rle_slot"),
    )

    # --- auth ---
    op.create_table(
        "sessions",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("token_hash", sa.String(), nullable=False),
        sa.Column("user_id", sa.Integer(), sa.ForeignKey("users.id"), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=False),
        sa.UniqueConstraint("token_hash", name="uq_sessions_token_hash"),
    )
    op.create_index("ix_sessions_user_id", "sessions", ["user_id"])


def downgrade() -> None:
    for table in reversed(_TABLES_IN_DEPENDENCY_ORDER):
        op.drop_table(table)
    _drop_enum_types()
