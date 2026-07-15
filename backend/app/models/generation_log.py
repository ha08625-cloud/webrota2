"""Generation decision log (Task 1 of the decision-log ticket).

`RotaGenerationLogEntry` persists the `DecisionLogEntry` records a
generation run collects in `engine.datatypes.DecisionLog` -- one row per
decision the engine made (clinic assignment, room displacement, swap
resolution, supervision assignment, duty application) while building a
rota. It is a diagnostic artifact, not a data model to build further
features on top of, which drives its two deliberate conventions:

1. `doctor_id`, `related_doctor_id`, `room_id`, `related_room_id`, and
   `clinic_type_id` are plain nullable integers with **no FK
   constraints**. Every row already carries a self-contained, human
   readable `message`, so an orphaned id in a historical entry (e.g. a
   clinic type deleted after the rota that referenced it was generated)
   is harmless. Real FKs would silently expand the delete-blocker surface
   for every referenced table -- `delete_clinic_type`'s 409 currently
   names "ClinicType {id} is referenced by counter or rota rows" and
   would need to grow a third clause, and the same problem would recur
   for doctors and rooms.

2. Rows are immutable after generation. They are written once, in the
   same transaction as the rota, by `generate._write_to_db()` on a
   successful pipeline run; an exception rolls the whole run back,
   including any log rows collected so far. `commit_rota()` and
   `rollback_commit()` never touch this table -- there is no snapshot/
   restore lifecycle here, unlike `RotaClinicCounterSnapshot` /
   `RotaSystemCounterSnapshot`. Cleanup happens only via the
   `cascade="all, delete-orphan"` relationship from `GeneratedRota` (see
   `RotaClosure` for the same pattern).

`rota_id` is the only real FK: rows have no meaning independent of the
rota that produced them.
"""
from sqlalchemy import ForeignKey, Integer, String, Text, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column, relationship

from ..database import Base
from .enums import Day, Period, enum_col


class RotaGenerationLogEntry(Base):
    __tablename__ = "rota_generation_log"
    __table_args__ = (
        UniqueConstraint("rota_id", "sequence", name="uq_rota_log_sequence"),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    rota_id: Mapped[int] = mapped_column(
        ForeignKey("generated_rotas.id"), nullable=False, index=True
    )
    sequence: Mapped[int] = mapped_column(Integer, nullable=False)
    phase: Mapped[str] = mapped_column(String(20), nullable=False)
    action: Mapped[str] = mapped_column(String(40), nullable=False)
    week: Mapped[int | None] = mapped_column(Integer, nullable=True)
    day: Mapped[Day | None] = mapped_column(enum_col(Day), nullable=True)
    period: Mapped[Period | None] = mapped_column(enum_col(Period), nullable=True)
    doctor_id: Mapped[int | None] = mapped_column(Integer, nullable=True)
    related_doctor_id: Mapped[int | None] = mapped_column(Integer, nullable=True)
    room_id: Mapped[int | None] = mapped_column(Integer, nullable=True)
    related_room_id: Mapped[int | None] = mapped_column(Integer, nullable=True)
    clinic_type_id: Mapped[int | None] = mapped_column(Integer, nullable=True)
    message: Mapped[str] = mapped_column(Text, nullable=False)

    rota: Mapped["GeneratedRota"] = relationship(back_populates="generation_log")  # noqa: F821