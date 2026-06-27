"""Counter models.

ClinicCounter supports two granularities controlled by ClinicType.counter_mode:
- shared:   day/period are NULL; one row per (doctor, clinic_type).
- per_slot: day/period are set; one row per (doctor, clinic_type, day, period).

The counter is keyed on day/period *values*, never on a ClinicTypeSchedule FK,
so the M3 replace-children edit pattern (delete + reinsert schedule rows) does
not cascade-delete counter history.

Uniqueness is enforced by two partial unique indexes because a plain unique over
nullable day/period would not stop duplicate shared rows (SQL treats NULLs as
distinct). Both partial indexes declare sqlite_where and postgresql_where to stay
portable across the SQLite-dev / Postgres-prod split.

Weighted score (raw_count / doctor.sessions_per_week) is computed at query time,
not stored.
"""
from sqlalchemy import CheckConstraint, ForeignKey, Index, Integer, UniqueConstraint, text
from sqlalchemy.orm import Mapped, mapped_column

from ..database import Base
from .enums import Day, Period, SystemCounterType, enum_col


class ClinicCounter(Base):
    __tablename__ = "clinic_counters"
    __table_args__ = (
        # day and period are both NULL (shared) or both set (per_slot).
        CheckConstraint(
            "(day IS NULL AND period IS NULL) "
            "OR (day IS NOT NULL AND period IS NOT NULL)",
            name="ck_clinic_counter_day_period",
        ),
        Index(
            "uq_clinic_counter_shared",
            "doctor_id",
            "clinic_type_id",
            unique=True,
            sqlite_where=text("day IS NULL"),
            postgresql_where=text("day IS NULL"),
        ),
        Index(
            "uq_clinic_counter_per_slot",
            "doctor_id",
            "clinic_type_id",
            "day",
            "period",
            unique=True,
            sqlite_where=text("day IS NOT NULL"),
            postgresql_where=text("day IS NOT NULL"),
        ),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    doctor_id: Mapped[int] = mapped_column(ForeignKey("doctors.id"), nullable=False)
    clinic_type_id: Mapped[int] = mapped_column(
        ForeignKey("clinic_types.id"), nullable=False
    )
    day: Mapped[Day | None] = mapped_column(enum_col(Day), nullable=True)
    period: Mapped[Period | None] = mapped_column(enum_col(Period), nullable=True)
    raw_count: Mapped[int] = mapped_column(Integer, nullable=False, default=0)


class SystemCounter(Base):
    __tablename__ = "system_counters"
    __table_args__ = (
        UniqueConstraint("doctor_id", "counter_type", name="uq_system_counter"),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    doctor_id: Mapped[int] = mapped_column(ForeignKey("doctors.id"), nullable=False)
    counter_type: Mapped[SystemCounterType] = mapped_column(
        enum_col(SystemCounterType), nullable=False
    )
    raw_count: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
