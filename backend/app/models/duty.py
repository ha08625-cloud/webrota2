"""DutyAssignment model: the pre-planned duty rota input. Not seeded."""
from sqlalchemy import Date, ForeignKey, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column
import datetime

from ..database import Base
from .enums import DutyType, Period, enum_col


class DutyAssignment(Base):
    __tablename__ = "duty_assignments"
    __table_args__ = (
        UniqueConstraint("date", "period", "duty_type", name="uq_duty_slot"),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    date: Mapped[datetime.date] = mapped_column(Date, nullable=False)
    period: Mapped[Period] = mapped_column(enum_col(Period), nullable=False)
    doctor_id: Mapped[int] = mapped_column(ForeignKey("doctors.id"), nullable=False)
    duty_type: Mapped[DutyType] = mapped_column(enum_col(DutyType), nullable=False)
