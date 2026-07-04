"""Counter snapshot models for the rota draft/commit/scrap lifecycle (M3).

When generate() persists a rota, it first snapshots every existing
ClinicCounter and SystemCounter row (their pre-generation values) against the
new GeneratedRota. While the rota is a draft, all counter mutations -- the
generation's own increments and any manual swap edits -- happen against the
live counter tables. Scrapping the draft restores every snapshotted value and
deletes any counter rows created after the snapshot; committing simply deletes
the snapshot, making the live values the baseline for future generations.

Rows are write-once: no unique constraints, no updates. At most one draft
exists at a time (enforced at the API layer), so at most one rota's snapshots
exist at a time -- bounded at roughly (doctors x clinic types) + system rows.
"""
from sqlalchemy import ForeignKey, Integer
from sqlalchemy.orm import Mapped, mapped_column

from ..database import Base
from .enums import SystemCounterType, enum_col


class RotaClinicCounterSnapshot(Base):
    __tablename__ = "rota_clinic_counter_snapshots"

    id: Mapped[int] = mapped_column(primary_key=True)
    rota_id: Mapped[int] = mapped_column(
        ForeignKey("generated_rotas.id"), nullable=False, index=True
    )
    doctor_id: Mapped[int] = mapped_column(ForeignKey("doctors.id"), nullable=False)
    clinic_type_id: Mapped[int] = mapped_column(
        ForeignKey("clinic_types.id"), nullable=False
    )
    value_before: Mapped[int] = mapped_column(Integer, nullable=False)


class RotaSystemCounterSnapshot(Base):
    __tablename__ = "rota_system_counter_snapshots"

    id: Mapped[int] = mapped_column(primary_key=True)
    rota_id: Mapped[int] = mapped_column(
        ForeignKey("generated_rotas.id"), nullable=False, index=True
    )
    doctor_id: Mapped[int] = mapped_column(ForeignKey("doctors.id"), nullable=False)
    counter_type: Mapped[SystemCounterType] = mapped_column(
        enum_col(SystemCounterType), nullable=False
    )
    value_before: Mapped[int] = mapped_column(Integer, nullable=False)
