"""initial schema -- the pre-go-live baseline

Revision ID: 001
Revises:
Create Date: 2026-01-01 00:00:00

The whole schema in one migration: 40 tables, 13 native enum types, 82
indexes. This replaces the 28-migration chain that accumulated while the
system was still pre-production; those migrations were collapsed into this
file immediately before go-live, on the last day it could be done by
reseeding rather than by migrating live data. Six of them existed only to
backfill rows in a database that was wiped afterwards, so nothing was
preserved by keeping them. Git history is the archive.

**Migrations are additive from here.** This file is finished: it describes
the schema as deployed, and the next schema change is 002, not another
regeneration of this one.

Two conventions matter to anyone editing this file.

*Enum types are created once, up front.* `--autogenerate` emits a
per-column `sa.Enum(...)`, which on Postgres means a `CREATE TYPE` per
column and a "type already exists" failure the second time an enum is
reused across tables -- and eleven of the thirteen are. Instead
`_create_enum_types()` creates every type explicitly at the top of
`upgrade()`, and columns reference them via `_enum()` with
`create_type=False`. On SQLite `_enum()` falls back to a generic
`sa.Enum`, which renders VARCHAR + CHECK and needs no type at all.

*Table order is dependency order.* `upgrade()` creates FK-free root tables
first, then dependents; `downgrade()` drops in exact reverse and then drops
the enum types. There is no DB-level ON DELETE CASCADE anywhere in this
schema except `school_holidays.school_id` -- parent/child cleanup is
ORM-level (`cascade="all, delete-orphan"`) everywhere else.

Column *order* within a table follows `app/models`, not the order in which
the old chain's `ALTER TABLE ADD COLUMN`s happened to run. That is the one
respect in which this baseline differs from what the 28 migrations produced,
it is invisible to the ORM, and it means `Base.metadata.create_all()` (what
the test suite uses) and `alembic upgrade head` (what Railway runs) now
agree column-for-column.
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
from app.models.reception import RECEPTION_FIRST_HOUR, RECEPTION_LAST_HOUR

revision: str = "001"
down_revision: Union[str, None] = None
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


_ALL_ENUMS = (
    RoomType, Site, DoctorType, SupervisionPreference, Day, Period, DutyType,
    RotaStatus, SystemCounterType, MasterSessionType, SessionRole,
    ReceptionRole, AccessLevel,
)

# Half-hourly slots only, within the practice's opening hours. Kept as one
# string so the three reception tables cannot drift apart; the bounds come
# from app.models.reception so widening opening hours is a single edit there
# plus a migration that re-states these constraints.
_HOUR_CHECK = (
    f"hour BETWEEN {RECEPTION_FIRST_HOUR} AND {RECEPTION_LAST_HOUR} "
    "AND (hour * 2) = CAST(hour * 2 AS INTEGER)"
)

_ROOM_XOR = (
    "(CASE WHEN room_id IS NULL THEN 0 ELSE 1 END) "
    "+ (CASE WHEN room_type IS NULL THEN 0 ELSE 1 END) = 1"
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
        sa.Column(
            "supervision_preference", _enum(SupervisionPreference),
            nullable=False, server_default=SupervisionPreference.NORMAL.value,
        ),
        # Employment window; null at either end means unbounded.
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
    # Partial unique index, not a unique constraint: clinic_priority must be a
    # contiguous 1..N sequence over enabled rows only, so disabled rows are
    # excluded rather than forced to hold distinct priorities.
    op.create_index(
        "uq_clinic_types_priority_enabled",
        "clinic_types", ["clinic_priority"], unique=True,
        postgresql_where=sa.text("is_enabled"),
        sqlite_where=sa.text("is_enabled"),
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
        # Tags the AM+PM pair as one of the eight fixed named bank holidays
        # in app/models/bank_holidays.py; null for an ad-hoc closure.
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
        sa.Column("text", sa.String(200), nullable=False),
        sa.Column("day", _enum(Day), nullable=False),
        sa.Column("period", _enum(Period), nullable=False),
        sa.Column(
            "is_active", sa.Boolean(), nullable=False, server_default=sa.true()
        ),
    )
    op.create_table(
        "users",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("email", sa.String(), nullable=False),
        sa.Column("name", sa.String(), nullable=False),
        sa.Column("password_hash", sa.String(), nullable=False),
        sa.Column("active", sa.Boolean(), nullable=False),
        sa.Column(
            "access_level", _enum(AccessLevel), nullable=False,
            server_default=AccessLevel.NURSE.value,
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
        "reception_rotas",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("date", sa.Date(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.UniqueConstraint("date", name="uq_reception_rotas_date"),
    )
    op.create_table(
        "reception_coverage_rules",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("day", _enum(Day), nullable=False),
        sa.Column("hour", sa.Float(), nullable=False),
        sa.Column("min_phones_staff", sa.Integer(), nullable=False),
        sa.CheckConstraint(_HOUR_CHECK, name="ck_rcr_hour"),
        sa.UniqueConstraint("day", "hour", name="uq_rcr_slot"),
    )

    # --- dependent tables ---
    op.create_table(
        "doctor_preferred_rooms",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("doctor_id", sa.Integer(), sa.ForeignKey("doctors.id"), nullable=False),
        sa.Column("preference_order", sa.Integer(), nullable=False),
        sa.Column("room_id", sa.Integer(), sa.ForeignKey("rooms.id"), nullable=True),
        sa.Column("room_type", _enum(RoomType), nullable=True),
        sa.CheckConstraint(_ROOM_XOR, name="ck_dpr_room_xor"),
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
        sa.CheckConstraint(_ROOM_XOR, name="ck_ctre_room_xor"),
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
        sa.Column("notes", sa.String(12), nullable=True),
        sa.UniqueConstraint("doctor_id", "date", "period", name="uq_leave_slot"),
    )
    op.create_table(
        "extra_session_entries",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("doctor_id", sa.Integer(), sa.ForeignKey("doctors.id"), nullable=False),
        sa.Column("date", sa.Date(), nullable=False),
        sa.Column("period", _enum(Period), nullable=False),
        sa.Column("notes", sa.String(12), nullable=True),
        sa.UniqueConstraint(
            "doctor_id", "date", "period", name="uq_extra_session_slot"
        ),
    )
    # A blocked slot is *not* leave: nothing that reads leave_entries may see
    # it, which is why it is a separate table rather than a flag.
    op.create_table(
        "blocked_entries",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("doctor_id", sa.Integer(), sa.ForeignKey("doctors.id"), nullable=False),
        sa.Column("date", sa.Date(), nullable=False),
        sa.Column("period", _enum(Period), nullable=False),
        sa.Column("notes", sa.String(12), nullable=True),
        sa.UniqueConstraint("doctor_id", "date", "period", name="uq_blocked_slot"),
    )
    # Sparse: no row means the entitlement rules in app/leave_entitlement.py
    # apply as-is. A row records a deviation from them.
    op.create_table(
        "leave_entitlements",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("doctor_id", sa.Integer(), sa.ForeignKey("doctors.id"), nullable=False),
        sa.Column("year", sa.Integer(), nullable=False),
        sa.Column("entitlement_sessions", sa.Numeric(5, 1), nullable=True),
        sa.Column(
            "carry_over_sessions", sa.Numeric(5, 1),
            nullable=False, server_default="0",
        ),
        sa.Column(
            "adjustment_sessions", sa.Numeric(5, 1),
            nullable=False, server_default="0",
        ),
        sa.Column("notes", sa.String(200), nullable=True),
        sa.UniqueConstraint(
            "doctor_id", "year", name="uq_leave_entitlement_doctor_year"
        ),
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
        "school_holidays",
        sa.Column("id", sa.Integer(), primary_key=True),
        # The only DB-level cascade in the schema: nothing holds an FK into
        # school_holidays and there is no per-rota snapshot, so deleting a
        # school hard-deletes its holidays.
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

    # --- staging (the editable copy of the template that feeds a run) ---
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
        # RotaConfig.template_start_week is always persisted as 1 on a staged
        # config, so the week the copy really started from is recorded here.
        sa.Column(
            "source_template_start_week", sa.Integer(),
            nullable=False, server_default="1",
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

    # --- generated rotas and their per-run snapshots ---
    op.create_table(
        "generated_rotas",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column(
            "config_id", sa.Integer(),
            sa.ForeignKey("rota_configs.id"), nullable=False,
        ),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("status", _enum(RotaStatus), nullable=False),
        # Both nullable lifecycle markers, not flags: committed_at drives
        # strict reverse-chronological rollback, archived_at is visibility only.
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
        # Generation-time snapshot of the template cell, so later template
        # edits cannot rewrite how a historical rota reads.
        sa.Column("template_type", _enum(MasterSessionType), nullable=True),
        sa.Column("is_wfh", sa.Boolean(), nullable=False),
        sa.Column("notes", sa.Text(), nullable=True),
        sa.Column(
            "is_supervising", sa.Boolean(), nullable=False,
            server_default=sa.false(),
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
    # Deliberately plain nullable integers, no FKs, on the *_id columns: every
    # row carries a self-contained message, so an orphaned id is harmless and
    # real FKs would widen the delete-blocker surface on every table named.
    op.create_table(
        "rota_generation_log",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column(
            "rota_id", sa.Integer(),
            sa.ForeignKey("generated_rotas.id"), nullable=False,
        ),
        sa.Column("sequence", sa.Integer(), nullable=False),
        sa.Column("phase", sa.String(20), nullable=False),
        sa.Column("action", sa.String(40), nullable=False),
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

    # --- reception rota ---
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
        sa.Column("note", sa.String(200), nullable=True),
        sa.CheckConstraint(_HOUR_CHECK, name="ck_rms_hour"),
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
        sa.Column("note", sa.String(200), nullable=True),
        sa.CheckConstraint(_HOUR_CHECK, name="ck_rrs_hour"),
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


def downgrade() -> None:
    for table in (
        # reception rota
        "reception_leave_entries",
        "reception_rota_sessions",
        "reception_master_sessions",
        # generated rotas and snapshots
        "rota_system_counter_snapshots",
        "rota_clinic_counter_snapshots",
        "rota_generation_log",
        "rota_closures",
        "rota_sessions",
        "generated_rotas",
        # staging
        "rota_staging_sessions",
        "rota_stagings",
        # dependents
        "sessions",
        "recurring_note_weeks",
        "recurring_note_doctors",
        "school_holidays",
        "master_rota_sessions",
        "duty_assignments",
        "leave_entitlements",
        "blocked_entries",
        "extra_session_entries",
        "leave_entries",
        "system_counters",
        "clinic_counters",
        "clinic_type_room_eligibilities",
        "clinic_type_doctor_eligibilities",
        "clinic_type_schedules",
        "doctor_signatures",
        "doctor_preferred_rooms",
        # roots
        "reception_coverage_rules",
        "reception_rotas",
        "reception_staff",
        "users",
        "recurring_notes",
        "schools",
        "practice_closures",
        "rota_configs",
        "master_rota_templates",
        "clinic_types",
        "doctors",
        "rooms",
    ):
        op.drop_table(table)
    _drop_enum_types()
