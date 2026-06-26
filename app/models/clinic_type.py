"""ClinicType and its three child tables.

ClinicType is the configurable unit for all assignment slots: school clinics,
college clinics, care homes, duty helpers, and any future type. Children are
seeded empty in M1 and populated via the API (M3) / frontend (M4).
"""
from sqlalchemy import (
    Boolean,
    CheckConstraint,
    ForeignKey,
    Integer,
    String,
    UniqueConstraint,
)
from sqlalchemy.orm import Mapped, mapped_column, relationship

from ..database import Base
from .enums import ClinicCounterMode, Day, Period, RoomType, enum_col


class ClinicType(Base):
    __tablename__ = "clinic_types"

    id: Mapped[int] = mapped_column(primary_key=True)
    name: Mapped[str] = mapped_column(String, unique=True, nullable=False)
    clinic_priority: Mapped[int] = mapped_column(Integer, nullable=False)
    is_enabled: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    counter_mode: Mapped[ClinicCounterMode] = mapped_column(
        enum_col(ClinicCounterMode), nullable=False, default=ClinicCounterMode.SHARED
    )
    category: Mapped[str | None] = mapped_column(String, nullable=True)
    room_required: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)

    schedules: Mapped[list["ClinicTypeSchedule"]] = relationship(
        back_populates="clinic_type", cascade="all, delete-orphan"
    )
    doctor_eligibilities: Mapped[list["ClinicTypeDoctorEligibility"]] = relationship(
        back_populates="clinic_type", cascade="all, delete-orphan"
    )
    room_eligibilities: Mapped[list["ClinicTypeRoomEligibility"]] = relationship(
        back_populates="clinic_type", cascade="all, delete-orphan"
    )

    def __repr__(self) -> str:  # pragma: no cover
        return f"<ClinicType {self.name} prio={self.clinic_priority}>"


class ClinicTypeSchedule(Base):
    __tablename__ = "clinic_type_schedules"
    __table_args__ = (
        UniqueConstraint("clinic_type_id", "day", "period", name="uq_cts_slot"),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    clinic_type_id: Mapped[int] = mapped_column(
        ForeignKey("clinic_types.id"), nullable=False
    )
    day: Mapped[Day] = mapped_column(enum_col(Day), nullable=False)
    period: Mapped[Period] = mapped_column(enum_col(Period), nullable=False)

    clinic_type: Mapped["ClinicType"] = relationship(back_populates="schedules")


class ClinicTypeDoctorEligibility(Base):
    __tablename__ = "clinic_type_doctor_eligibilities"
    __table_args__ = (
        UniqueConstraint("clinic_type_id", "doctor_id", name="uq_ctde_doctor"),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    clinic_type_id: Mapped[int] = mapped_column(
        ForeignKey("clinic_types.id"), nullable=False
    )
    doctor_id: Mapped[int] = mapped_column(ForeignKey("doctors.id"), nullable=False)
    doctor_priority: Mapped[int] = mapped_column(Integer, nullable=False, default=1000)

    clinic_type: Mapped["ClinicType"] = relationship(back_populates="doctor_eligibilities")
    doctor: Mapped["Doctor"] = relationship()  # type: ignore[name-defined]  # noqa: F821


class ClinicTypeRoomEligibility(Base):
    __tablename__ = "clinic_type_room_eligibilities"
    __table_args__ = (
        CheckConstraint(
            "(CASE WHEN room_id IS NULL THEN 0 ELSE 1 END) "
            "+ (CASE WHEN room_type IS NULL THEN 0 ELSE 1 END) = 1",
            name="ck_ctre_room_xor",
        ),
        UniqueConstraint("clinic_type_id", "room_id", name="uq_ctre_room_id"),
        UniqueConstraint("clinic_type_id", "room_type", name="uq_ctre_room_type"),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    clinic_type_id: Mapped[int] = mapped_column(
        ForeignKey("clinic_types.id"), nullable=False
    )
    room_id: Mapped[int | None] = mapped_column(ForeignKey("rooms.id"), nullable=True)
    room_type: Mapped[RoomType | None] = mapped_column(enum_col(RoomType), nullable=True)

    clinic_type: Mapped["ClinicType"] = relationship(back_populates="room_eligibilities")
    room: Mapped["Room | None"] = relationship()  # type: ignore[name-defined]  # noqa: F821
