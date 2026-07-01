"""initial schema (all 16 tables)

Revision ID: 001
Revises:
Create Date: 2026-01-01 00:00:00

Hand-authored to mirror app.models. Per the M1 plan, this single migration is
regenerated/overwritten as the schema evolves through M1-M2; it is finalised as
the deployment baseline at M3 (Railway + Postgres).

Clinic counters are shared-only (one row per doctor per clinic type). An
earlier per_slot design (ClinicCounterMode, ClinicCounter.day/period) was
reversed before M2 and never shipped to a persistent database, so it is
removed here rather than carried forward as a migration.
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa

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
    enum_col,
)

revision: str = "001"
down_revision: Union[str, None] = None
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # --- root tables (no FKs) ---
    op.create_table(
        "rooms",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("code", sa.String(), nullable=False),
        sa.Column("room_type", enum_col(RoomType), nullable=False),
        sa.Column("site", enum_col(Site), nullable=False),
        sa.UniqueConstraint("code", name="uq_rooms_code"),
    )
    op.create_table(
        "doctors",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("code", sa.String(), nullable=False),
        sa.Column("doctor_type", enum_col(DoctorType), nullable=False),
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
        sa.Column("room_type", enum_col(RoomType), nullable=True),
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
        sa.Column("day", enum_col(Day), nullable=False),
        sa.Column("period", enum_col(Period), nullable=False),
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
        sa.Column("room_type", enum_col(RoomType), nullable=True),
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
        sa.Column("counter_type", enum_col(SystemCounterType), nullable=False),
        sa.Column("raw_count", sa.Integer(), nullable=False),
        sa.UniqueConstraint("doctor_id", "counter_type", name="uq_system_counter"),
    )
    op.create_table(
        "leave_entries",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("doctor_id", sa.Integer(), sa.ForeignKey("doctors.id"), nullable=False),
        sa.Column("date", sa.Date(), nullable=False),
        sa.Column("period", enum_col(Period), nullable=False),
        sa.UniqueConstraint("doctor_id", "date", "period", name="uq_leave_slot"),
    )
    op.create_table(
        "duty_assignments",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("date", sa.Date(), nullable=False),
        sa.Column("period", enum_col(Period), nullable=False),
        sa.Column("doctor_id", sa.Integer(), sa.ForeignKey("doctors.id"), nullable=False),
        sa.Column("duty_type", enum_col(DutyType), nullable=False),
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
        sa.Column("day", enum_col(Day), nullable=False),
        sa.Column("period", enum_col(Period), nullable=False),
        sa.Column("session_type", enum_col(MasterSessionType), nullable=False),
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
        sa.Column("status", enum_col(RotaStatus), nullable=False),
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
        sa.Column("day", enum_col(Day), nullable=False),
        sa.Column("period", enum_col(Period), nullable=False),
        sa.Column("room_id", sa.Integer(), sa.ForeignKey("rooms.id"), nullable=True),
        sa.Column(
            "clinic_type_id", sa.Integer(),
            sa.ForeignKey("clinic_types.id"), nullable=True,
        ),
        sa.Column("role", enum_col(SessionRole), nullable=True),
        sa.Column("is_wfh", sa.Boolean(), nullable=False),
        sa.Column("notes", sa.Text(), nullable=True),
        sa.UniqueConstraint(
            "rota_id", "doctor_id", "week", "day", "period",
            name="uq_rota_session_slot",
        ),
    )


def downgrade() -> None:
    for table in (
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