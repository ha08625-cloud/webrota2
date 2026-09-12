"""Counter snapshot models for the rota draft/commit/scrap/rollback
lifecycle.

When generate() persists a rota, it first snapshots every existing
ClinicCounter and SystemCounter row (their pre-generation values) against the
new GeneratedRota. While the rota is a draft, all counter mutations -- the
generation's own increments and any manual swap edits -- happen against the
live counter tables. Scrapping the draft restores every snapshotted value and
deletes any counter rows created after the snapshot.

Committing does not delete the snapshot. The live values become the
baseline for future generations, but the snapshot itself persists as a
permanent audit record: it is what rollback_commit() restores from when
undoing a commit, walking backwards through commit history one step at a
time. A snapshot is deleted only when its rota is eventually scrapped --
directly from a draft, or after being rolled back from committed.

Rows are write-once: no unique constraints, no updates. At most one draft
exists at a time (enforced at the API layer), but snapshot storage is not
bounded to "at most one rota's worth" in total -- every committed rota that
is never rolled back keeps its snapshot rows indefinitely, so total storage
grows by roughly (doctors x clinic types) + system rows per commit. No
retention/archival policy exists yet; this is an accepted tradeoff, not an
oversight.
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