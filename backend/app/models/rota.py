"""Generation-side models: RotaConfig, GeneratedRota, RotaSession.

RotaSession stores generated assignments (room_id, clinic_type_id, role,
is_wfh, notes) plus template_type: the MasterSessionType the slot had in
the template at generation time, persisted directly on the row rather than
re-derived at read time. Sessions are meant to be self-contained snapshots,
and read-time re-derivation via MasterRotaSession would let an edit to the
master template silently rewrite the appearance of a historical committed
rota. template_type is nullable, and a null reads as "normal session" in
both the API and the frontend. is_on_leave is not stored; it is derived
from LeaveEntry at query time.

GeneratedRota.committed_at records when a rota was committed and is what
rollback_commit() uses to find "the most recently committed rota" and to
enforce strict reverse-chronological rollback order. It is set in
commit_rota() and cleared in rollback_commit(); a committed rota with a
NULL committed_at is treated as not rollbackable.

GeneratedRota.archived_at is a pure visibility flag on committed rotas --
it hides a rota from the default "Committed" list on RotaPage without
touching counters, sessions, or rollback eligibility. It is set/cleared via
the archive and unarchive endpoints, and is also cleared by
rollback_commit() when a rota flips back to draft (commit_rota() self-heals
committed_at on re-commit, so a surviving archived_at would silently
re-archive a freshly re-committed rota). rollback_commit()'s eligibility
checks otherwise ignore archived_at entirely.
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
    false,
)
from sqlalchemy.orm import Mapped, mapped_column, relationship

from ..database import Base
from .enums import Day, MasterSessionType, Period, RotaStatus, SessionRole, enum_col


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
    # RotaConfigNote lives in models/recurring_note.py. The cascade is
    # load-bearing: routers/staging.py::abandon_staging hard-deletes the
    # staging and then its RotaConfig, which would raise an IntegrityError
    # against any note picked for that run without it.
    notes: Mapped[list["RotaConfigNote"]] = relationship(  # noqa: F821
        cascade="all, delete-orphan"
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
    committed_at: Mapped[datetime.datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True, default=None
    )
    archived_at: Mapped[datetime.datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True, default=None
    )

    config: Mapped["RotaConfig"] = relationship(back_populates="rotas")
    sessions: Mapped[list["RotaSession"]] = relationship(
        back_populates="rota", cascade="all, delete-orphan"
    )
    closures: Mapped[list["RotaClosure"]] = relationship(
        back_populates="rota", cascade="all, delete-orphan"
    )
    generation_log: Mapped[list["RotaGenerationLogEntry"]] = relationship(
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
    template_type: Mapped[MasterSessionType | None] = mapped_column(
        enum_col(MasterSessionType), nullable=True
    )
    is_wfh: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    notes: Mapped[str | None] = mapped_column(Text, nullable=True)
    is_supervising: Mapped[bool] = mapped_column(
        Boolean, nullable=False, default=False, server_default=false()
    )

    rota: Mapped["GeneratedRota"] = relationship(back_populates="sessions")