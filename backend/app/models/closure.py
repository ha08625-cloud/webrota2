"""Practice closure models (M5 bank-holiday weeks, half-day granularity).

PracticeClosure is global planning data (e.g. "Easter Monday") entered
independently of any generation run -- the Duty page needs to know about a
closure weeks before a RotaConfig exists. Closures are per (date, period)
slots, mirroring LeaveEntry's half-day granularity: a full-day closure is
two rows for the same date, one per period.

RotaClosure snapshots which closed slots fell inside a rota's range at
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
from .enums import Period, enum_col


class PracticeClosure(Base):
    __tablename__ = "practice_closures"
    __table_args__ = (
        UniqueConstraint("date", "period", name="uq_practice_closure_slot"),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    date: Mapped[datetime.date] = mapped_column(Date, nullable=False)
    period: Mapped[Period] = mapped_column(enum_col(Period), nullable=False)
    name: Mapped[str | None] = mapped_column(String, nullable=True)


class RotaClosure(Base):
    __tablename__ = "rota_closures"
    __table_args__ = (
        UniqueConstraint("rota_id", "date", "period", name="uq_rota_closure_slot"),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    rota_id: Mapped[int] = mapped_column(
        ForeignKey("generated_rotas.id"), nullable=False, index=True
    )
    date: Mapped[datetime.date] = mapped_column(Date, nullable=False)
    period: Mapped[Period] = mapped_column(enum_col(Period), nullable=False)

    rota: Mapped["GeneratedRota"] = relationship(back_populates="closures")  # noqa: F821