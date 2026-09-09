"""School and SchoolHoliday models (global planning data, zero engine coupling).

Like PracticeClosure, a School's holidays are entered independently of any
generation run and exist purely so a leave approver can see that a request
lands in half term. Unlike PracticeClosure, nothing here is read by
context.load_context(), the generation engine, the coverage endpoint, or any
rota snapshot -- there is no RotaSchoolHoliday table and there never should
be one. A SchoolHoliday never suppresses a slot, never changes a coverage
total, and never blocks a duty assignment.

SchoolHoliday is deliberately a contiguous date range (start_date, end_date)
rather than PracticeClosure's per-(date, period) rows. Closures are per-slot
because the engine looks up (date, period) membership; nothing looks these
up, and a six-week summer holiday as 42 rows would be pure noise in the UI.
Do not "fix" this into PracticeClosure's shape -- the two models solve
different problems.
"""
import datetime

from sqlalchemy import Date, ForeignKey, String, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column, relationship

from ..database import Base


class School(Base):
    __tablename__ = "schools"
    __table_args__ = (UniqueConstraint("name", name="uq_school_name"),)

    id: Mapped[int] = mapped_column(primary_key=True)
    name: Mapped[str] = mapped_column(String, nullable=False)

    holidays: Mapped[list["SchoolHoliday"]] = relationship(
        back_populates="school",
        cascade="all, delete-orphan",
        order_by="SchoolHoliday.start_date",
    )

    def __repr__(self) -> str:  # pragma: no cover
        return f"<School {self.name}>"


class SchoolHoliday(Base):
    __tablename__ = "school_holidays"

    id: Mapped[int] = mapped_column(primary_key=True)
    school_id: Mapped[int] = mapped_column(
        ForeignKey("schools.id", ondelete="CASCADE"), nullable=False, index=True
    )
    start_date: Mapped[datetime.date] = mapped_column(Date, nullable=False)
    end_date: Mapped[datetime.date] = mapped_column(Date, nullable=False)
    name: Mapped[str | None] = mapped_column(String, nullable=True)

    school: Mapped["School"] = relationship(back_populates="holidays")
