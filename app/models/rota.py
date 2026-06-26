"""Generation-side models: RotaConfig, GeneratedRota, RotaSession.

RotaSession stores generated assignments only (room_id, clinic_type_id, role,
is_wfh, notes). It has no session_type column: the template type is re-derivable
from MasterRotaSession via (doctor, template_week, day, period). is_on_leave is
not stored; it is derived from LeaveEntry at query time.
"""
import datetime

from sqlalchemy import (
    Boolean,
    CheckConstraint,
    Date,
    DateTime,
    ForeignKey,
    Integer,
    Text,
    UniqueConstraint,
)
from sqlalchemy.orm import Mapped, mapped_column, relationship

from ..database import Base
from .enums import Day, Period, RotaStatus, SessionRole, enum_col


class RotaConfig(Base):
    __tablename__ = "rota_configs"
    __table_args__ = (
        CheckConstraint("num_weeks IN (1, 2, 4)", name="ck_config_num_weeks"),
        CheckConstraint(
            "template_start_week BETWEEN 1 AND 4", name="ck_config_template_start_week"
        ),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    start_date: Mapped[datetime.date] = mapped_column(Date, nullable=False)
    num_weeks: Mapped[int] = mapped_column(Integer, nullable=False)
    template_start_week: Mapped[int] = mapped_column(Integer, nullable=False, default=1)
    created_at: Mapped[datetime.datetime] = mapped_column(
        DateTime(timezone=True),
        nullable=False,
        default=lambda: datetime.datetime.now(datetime.timezone.utc),
    )

    rotas: Mapped[list["GeneratedRota"]] = relationship(
        back_populates="config", cascade="all, delete-orphan"
    )


class GeneratedRota(Base):
    __tablename__ = "generated_rotas"

    id: Mapped[int] = mapped_column(primary_key=True)
    config_id: Mapped[int] = mapped_column(ForeignKey("rota_configs.id"), nullable=False)
    created_at: Mapped[datetime.datetime] = mapped_column(
        DateTime(timezone=True),
        nullable=False,
        default=lambda: datetime.datetime.now(datetime.timezone.utc),
    )
    status: Mapped[RotaStatus] = mapped_column(
        enum_col(RotaStatus), nullable=False, default=RotaStatus.DRAFT
    )

    config: Mapped["RotaConfig"] = relationship(back_populates="rotas")
    sessions: Mapped[list["RotaSession"]] = relationship(
        back_populates="rota", cascade="all, delete-orphan"
    )


class RotaSession(Base):
    __tablename__ = "rota_sessions"
    __table_args__ = (
        UniqueConstraint(
            "rota_id", "doctor_id", "week", "day", "period", name="uq_rota_session_slot"
        ),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    rota_id: Mapped[int] = mapped_column(ForeignKey("generated_rotas.id"), nullable=False)
    doctor_id: Mapped[int] = mapped_column(ForeignKey("doctors.id"), nullable=False)
    week: Mapped[int] = mapped_column(Integer, nullable=False)
    day: Mapped[Day] = mapped_column(enum_col(Day), nullable=False)
    period: Mapped[Period] = mapped_column(enum_col(Period), nullable=False)
    room_id: Mapped[int | None] = mapped_column(ForeignKey("rooms.id"), nullable=True)
    clinic_type_id: Mapped[int | None] = mapped_column(
        ForeignKey("clinic_types.id"), nullable=True
    )
    role: Mapped[SessionRole | None] = mapped_column(enum_col(SessionRole), nullable=True)
    is_wfh: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    notes: Mapped[str | None] = mapped_column(Text, nullable=True)

    rota: Mapped["GeneratedRota"] = relationship(back_populates="sessions")
