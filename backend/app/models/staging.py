"""RotaStaging and RotaStagingSession.

Editable staging step between the master rota template and generation
(see the staging plan). A staging is a run-scoped copy of the active
template's rows for a date range: the user makes one-off edits here, then
the existing Phase 0-12 pipeline runs against the edited copy. The master
template itself is never touched.

`completed_at` (nullable, matching GeneratedRota.committed_at/archived_at)
is the lifecycle marker: null means active, set means completed. "Active
staging exists" is a direct query against this column, independent of
whatever later happens to the GeneratedRota produced from it.

`config_id` is unique: at most one staging per RotaConfig, and in practice
at most one active staging globally (enforced in app logic via
get_active_staging(), not the schema).

`source_template_id` is stored so the staging branch in load_context() can
load the template by id (ignoring is_active), so deactivating or adding
templates after staging create cannot brick an in-progress staging.

`source_template_start_week` records the template week the copy started
from. routers/staging.py applies the requested start week at copy time and
then persists `template_start_week=1` on the staging's RotaConfig, which is
the invariant that makes week_map.template_week() the identity for a staged
run and lets Phases 0-12 run unchanged. That normalisation destroys the only
other record of the real anchor, so this column is it. Recurring-note week
resolution depends on it: a note scoped to template weeks {1,3} must fire on
the correct real-world fortnight, not on staging *generation* weeks 1 and 3.
Set at staging create; read by engine/context.py, which is the only
staging-aware code in the engine.

RotaStagingSession mirrors MasterRotaSession's shape exactly, replacing
template_id with staging_id. Real dates are not stored here - week/day/
period plus the parent staging's linked RotaConfig.start_date is enough
to derive them, same as MasterRotaSession relative to a generation run.
"""
import datetime

from sqlalchemy import (
    CheckConstraint,
    DateTime,
    ForeignKey,
    Integer,
    UniqueConstraint,
)
from sqlalchemy.orm import Mapped, mapped_column, relationship

from ..database import Base
from .enums import Day, MasterSessionType, Period, enum_col


class RotaStaging(Base):
    __tablename__ = "rota_stagings"
    __table_args__ = (
        UniqueConstraint("config_id", name="uq_rota_stagings_config_id"),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    config_id: Mapped[int] = mapped_column(
        ForeignKey("rota_configs.id"), nullable=False
    )
    source_template_id: Mapped[int] = mapped_column(
        ForeignKey("master_rota_templates.id"), nullable=False
    )
    source_template_start_week: Mapped[int] = mapped_column(
        Integer, nullable=False, default=1, server_default="1"
    )
    created_at: Mapped[datetime.datetime] = mapped_column(
        DateTime(timezone=True),
        nullable=False,
        default=lambda: datetime.datetime.now(datetime.timezone.utc),
    )
    completed_at: Mapped[datetime.datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True, default=None
    )

    sessions: Mapped[list["RotaStagingSession"]] = relationship(
        back_populates="staging", cascade="all, delete-orphan"
    )


class RotaStagingSession(Base):
    __tablename__ = "rota_staging_sessions"
    __table_args__ = (
        CheckConstraint("week BETWEEN 1 AND 4", name="ck_rss_week"),
        UniqueConstraint(
            "staging_id", "doctor_id", "week", "day", "period", name="uq_rss_slot"
        ),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    staging_id: Mapped[int] = mapped_column(
        ForeignKey("rota_stagings.id"), nullable=False
    )
    doctor_id: Mapped[int] = mapped_column(ForeignKey("doctors.id"), nullable=False)
    week: Mapped[int] = mapped_column(Integer, nullable=False)
    day: Mapped[Day] = mapped_column(enum_col(Day), nullable=False)
    period: Mapped[Period] = mapped_column(enum_col(Period), nullable=False)
    session_type: Mapped[MasterSessionType] = mapped_column(
        enum_col(MasterSessionType), nullable=False
    )
    room_id: Mapped[int | None] = mapped_column(ForeignKey("rooms.id"), nullable=True)

    staging: Mapped["RotaStaging"] = relationship(back_populates="sessions")
    doctor: Mapped["Doctor"] = relationship()  # type: ignore[name-defined]  # noqa: F821
    room: Mapped["Room | None"] = relationship()  # type: ignore[name-defined]  # noqa: F821