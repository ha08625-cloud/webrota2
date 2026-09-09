"""BlockedEntry model.

A doctor blocked on a (date, period) for something that isn't leave and
isn't an extra session -- a whole-day training session is the canonical
case (clinical rota, "Blocked" annual planner option). Structurally
identical to LeaveEntry/ExtraSessionEntry, but a distinct table: nothing
that reads leave_entries or extra_session_entries (the engine included)
should see a blocked slot, since blocked doctors are still, factually,
assigned to their normal working pattern -- they are just unavailable for
clinical cover. The Annual Planner's coverage total treats a blocked slot
the same way it treats leave (excluded from headcount) without writing a
LeaveEntry row.
"""
from sqlalchemy import Date, ForeignKey, String, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column
import datetime

from ..database import Base
from .enums import Period, enum_col

# Matches the Annual Planner cell's character limit -- there is very
# little room to render free text in a cell that also shows AM/PM.
NOTES_MAX_LENGTH = 12


class BlockedEntry(Base):
    __tablename__ = "blocked_entries"
    __table_args__ = (
        UniqueConstraint("doctor_id", "date", "period", name="uq_blocked_slot"),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    doctor_id: Mapped[int] = mapped_column(ForeignKey("doctors.id"), nullable=False)
    date: Mapped[datetime.date] = mapped_column(Date, nullable=False)
    period: Mapped[Period] = mapped_column(enum_col(Period), nullable=False)
    notes: Mapped[str | None] = mapped_column(String(NOTES_MAX_LENGTH), nullable=True)
