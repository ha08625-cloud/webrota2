"""Counter models.

ClinicCounter is shared-only: one row per (doctor, clinic_type). A clinic
always uses a single shared counter regardless of how many schedule slots
the clinic type has -- there is no per-(day, period) counter granularity.

Weighted score ((raw_count + opening_balance) / doctor.sessions_per_week) is
computed at query time, not stored.

`opening_balance` is a credit in sessions, added to `raw_count` before the
score is computed, so a doctor who joined part-way through can be started
level with their peers instead of at zero (a zero raw count otherwise reads
as "maximally under-loaded" and the engine prefers them until they catch
up). It is stored separately from `raw_count` and the engine never writes
it: the draft snapshots (`counter_snapshot.py`) capture `raw_count` only, so
a balance the engine cannot touch needs no snapshot column and cannot be
corrupted by scrap/restore. Folding the credit into `raw_count` instead
would make it indistinguishable from work actually done, and a reset would
silently destroy it. Resetting a counter to zero clears the balance as well
-- after a reset everyone is level by definition, so a surviving credit
would re-introduce the skew it was created to remove. Negative balances are
allowed (a doctor returning from a long absence, or a leaver whose count
should read as already served).
"""
from decimal import Decimal

from sqlalchemy import ForeignKey, Integer, Numeric, UniqueConstraint
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
    opening_balance: Mapped[Decimal] = mapped_column(
        Numeric(5, 1), nullable=False, default=Decimal("0.0"), server_default="0"
    )


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
    opening_balance: Mapped[Decimal] = mapped_column(
        Numeric(5, 1), nullable=False, default=Decimal("0.0"), server_default="0"
    )