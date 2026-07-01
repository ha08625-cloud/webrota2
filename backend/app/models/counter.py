"""Counter models.

ClinicCounter is shared-only: one row per (doctor, clinic_type). An earlier
design considered a per_slot granularity (one counter per doctor per clinic
per day/period); this was reversed before M2 — see python_roadmap_updated.md
Design Decisions. Clinics always use a single shared counter regardless of
how many schedule slots the clinic type has.

Weighted score (raw_count / doctor.sessions_per_week) is computed at query
time, not stored.
"""
from sqlalchemy import ForeignKey, Integer, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column

from ..database import Base
from .enums import SystemCounterType, enum_col


class ClinicCounter(Base):
    __tablename__ = "clinic_counters"
    __table_args__ = (
        UniqueConstraint("doctor_id", "clinic_type_id", name="uq_clinic_counter"),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    doctor_id: Mapped[int] = mapped_column(ForeignKey("doctors.id"), nullable=False)
    clinic_type_id: Mapped[int] = mapped_column(
        ForeignKey("clinic_types.id"), nullable=False
    )
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