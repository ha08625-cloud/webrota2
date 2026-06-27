"""LeaveEntry model. Not seeded in M1."""
from sqlalchemy import Date, ForeignKey, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column
import datetime

from ..database import Base
from .enums import Period, enum_col


class LeaveEntry(Base):
    __tablename__ = "leave_entries"
    __table_args__ = (
        UniqueConstraint("doctor_id", "date", "period", name="uq_leave_slot"),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    doctor_id: Mapped[int] = mapped_column(ForeignKey("doctors.id"), nullable=False)
    date: Mapped[datetime.date] = mapped_column(Date, nullable=False)
    period: Mapped[Period] = mapped_column(enum_col(Period), nullable=False)
