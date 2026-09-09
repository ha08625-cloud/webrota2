"""Doctor and DoctorPreferredRoom models."""
import datetime
from decimal import Decimal

from sqlalchemy import (
    Boolean,
    CheckConstraint,
    Date,
    ForeignKey,
    Integer,
    Numeric,
    String,
    UniqueConstraint,
)
from sqlalchemy.orm import Mapped, mapped_column, relationship

from ..api.auth_utils import new_session_token
from ..database import Base
from .enums import DoctorType, RoomType, SupervisionPreference, enum_col


class Doctor(Base):
    __tablename__ = "doctors"
    __table_args__ = (UniqueConstraint("code", name="uq_doctors_code"),)

    id: Mapped[int] = mapped_column(primary_key=True)
    code: Mapped[str] = mapped_column(String, nullable=False)
    doctor_type: Mapped[DoctorType] = mapped_column(enum_col(DoctorType), nullable=False)
    sessions_per_week: Mapped[Decimal] = mapped_column(
        Numeric(4, 1), nullable=False, default=Decimal("10.0")
    )
    active: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    supervision_preference: Mapped[SupervisionPreference] = mapped_column(
        enum_col(SupervisionPreference),
        nullable=False,
        default=SupervisionPreference.NORMAL,
        server_default=SupervisionPreference.NORMAL.value,
    )
    # Employment window: the doctor works only on dates within it. Null at
    # either end means unbounded, which is every pre-existing row and the
    # default for a new one. Deliberately NOT a check constraint on the
    # ordering -- the pair is validated at the API boundary (same place the
    # room XOR is also enforced), so a PATCH that sets one end before the
    # other stays workable.
    start_date: Mapped[datetime.date | None] = mapped_column(Date, nullable=True)
    end_date: Mapped[datetime.date | None] = mapped_column(Date, nullable=True)
    # Secret that identifies this doctor's public .ics calendar feed. Every
    # row has one from creation -- the feed route looks it up through the
    # unique index and never has to handle a null. Deliberately NOT a server
    # default: there is no single value the rows could share, so the Python
    # default here (and the per-row backfill in migration 007) is what makes
    # the NOT NULL safe. Reuses the session-token generator so "unguessable
    # token" has one definition in the codebase; auth_utils is a leaf module
    # with no app imports of its own, so this does not tangle the layering.
    # Kept out of DoctorOut/DoctorDetailOut -- it reaches the frontend only
    # through GET /doctors/{id}/calendar-feed.
    calendar_token: Mapped[str] = mapped_column(
        String, nullable=False, unique=True, index=True, default=new_session_token
    )

    preferred_rooms: Mapped[list["DoctorPreferredRoom"]] = relationship(
        back_populates="doctor",
        cascade="all, delete-orphan",
        order_by="DoctorPreferredRoom.preference_order",
    )

    def __repr__(self) -> str:  # pragma: no cover
        return f"<Doctor {self.code} ({self.doctor_type.value})>"


class DoctorPreferredRoom(Base):
    __tablename__ = "doctor_preferred_rooms"
    __table_args__ = (
        # Exactly one of room_id / room_type must be set.
        CheckConstraint(
            "(CASE WHEN room_id IS NULL THEN 0 ELSE 1 END) "
            "+ (CASE WHEN room_type IS NULL THEN 0 ELSE 1 END) = 1",
            name="ck_dpr_room_xor",
        ),
        UniqueConstraint("doctor_id", "preference_order", name="uq_dpr_doctor_order"),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    doctor_id: Mapped[int] = mapped_column(ForeignKey("doctors.id"), nullable=False)
    preference_order: Mapped[int] = mapped_column(Integer, nullable=False)
    room_id: Mapped[int | None] = mapped_column(ForeignKey("rooms.id"), nullable=True)
    room_type: Mapped[RoomType | None] = mapped_column(enum_col(RoomType), nullable=True)

    doctor: Mapped["Doctor"] = relationship(back_populates="preferred_rooms")
    room: Mapped["Room | None"] = relationship()  # type: ignore[name-defined]  # noqa: F821