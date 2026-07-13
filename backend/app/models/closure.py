"""Practice closure models (M5 bank-holiday weeks).

PracticeClosure is global planning data (e.g. "Easter Monday") entered
independently of any generation run -- the Duty page needs to know about a
closure weeks before a RotaConfig exists.

RotaClosure snapshots which closed dates fell inside a rota's range at
generation time, mirroring the RotaSession/template_type snapshot principle:
deleting or adding a PracticeClosure after a draft/committed rota exists must
not change how that rota renders or validates. generate.py writes these rows
in the same transaction as the rota; grid_utils.rebuild_rota_grid() reads
from this table, not PracticeClosure, when reconstructing a persisted rota.
"""
import datetime

from sqlalchemy import Date, ForeignKey, String, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column, relationship

from ..database import Base


class PracticeClosure(Base):
    __tablename__ = "practice_closures"

    id: Mapped[int] = mapped_column(primary_key=True)
    date: Mapped[datetime.date] = mapped_column(Date, unique=True, nullable=False)
    name: Mapped[str | None] = mapped_column(String, nullable=True)


class RotaClosure(Base):
    __tablename__ = "rota_closures"
    __table_args__ = (
        UniqueConstraint("rota_id", "date", name="uq_rota_closure_date"),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    rota_id: Mapped[int] = mapped_column(
        ForeignKey("generated_rotas.id"), nullable=False, index=True
    )
    date: Mapped[datetime.date] = mapped_column(Date, nullable=False)

    rota: Mapped["GeneratedRota"] = relationship(back_populates="closures")  # noqa: F821