"""MasterRotaTemplate and MasterRotaSession.

The template is week-specific (week 1-4): some doctors have different rooms or
session types in different weeks (e.g. CL is D1 on Thursday in weeks 1/3 and W1
in weeks 2/4). Single-active-template is enforced in app logic, not the schema.
"""
import datetime

from sqlalchemy import (
    Boolean,
    CheckConstraint,
    DateTime,
    ForeignKey,
    Integer,
    String,
    UniqueConstraint,
)
from sqlalchemy.orm import Mapped, mapped_column, relationship

from ..database import Base
from .enums import Day, MasterSessionType, Period, enum_col


class MasterRotaTemplate(Base):
    __tablename__ = "master_rota_templates"

    id: Mapped[int] = mapped_column(primary_key=True)
    name: Mapped[str] = mapped_column(String, nullable=False)
    is_active: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    created_at: Mapped[datetime.datetime] = mapped_column(
        DateTime(timezone=True),
        nullable=False,
        default=lambda: datetime.datetime.now(datetime.timezone.utc),
    )

    sessions: Mapped[list["MasterRotaSession"]] = relationship(
        back_populates="template", cascade="all, delete-orphan"
    )


class MasterRotaSession(Base):
    __tablename__ = "master_rota_sessions"
    __table_args__ = (
        CheckConstraint("week BETWEEN 1 AND 4", name="ck_mrs_week"),
        UniqueConstraint(
            "template_id", "doctor_id", "week", "day", "period", name="uq_mrs_slot"
        ),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    template_id: Mapped[int] = mapped_column(
        ForeignKey("master_rota_templates.id"), nullable=False
    )
    doctor_id: Mapped[int] = mapped_column(ForeignKey("doctors.id"), nullable=False)
    week: Mapped[int] = mapped_column(Integer, nullable=False)
    day: Mapped[Day] = mapped_column(enum_col(Day), nullable=False)
    period: Mapped[Period] = mapped_column(enum_col(Period), nullable=False)
    session_type: Mapped[MasterSessionType] = mapped_column(
        enum_col(MasterSessionType), nullable=False
    )
    room_id: Mapped[int | None] = mapped_column(ForeignKey("rooms.id"), nullable=True)

    template: Mapped["MasterRotaTemplate"] = relationship(back_populates="sessions")
    doctor: Mapped["Doctor"] = relationship()  # type: ignore[name-defined]  # noqa: F821
    room: Mapped["Room | None"] = relationship()  # type: ignore[name-defined]  # noqa: F821
