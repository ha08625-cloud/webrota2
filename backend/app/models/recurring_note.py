"""Recurring-note *definitions* and their per-run instances.

Two layers, and the split is the whole point of this module:

**Definition** (`RecurringNote` + `RecurringNoteDoctor`) is a named meeting
kept in a library -- "Significant events meeting", Wednesday PM, these
doctors. It schedules nothing. Day, period and the doctor list are
*defaults* that a pick copies; `is_active` only controls whether the
definition is still offered in the picker.

**Instance** (`RotaConfigNote` + `RotaConfigNoteDoctor`) is what the engine
actually reads. Ticking a definition on the staging page copies its text,
day, period and doctors onto a row hanging off the run's `RotaConfig`, for
one or more *generation* weeks chosen by the user for that run. The copy is
a snapshot: editing, deactivating or deleting the definition afterwards
does not touch instances already picked (delete nulls `source_note_id`,
which is provenance for the UI only -- it is never re-read for content).
A free-form one-off note has `source_note_id = NULL` from the start.

Meetings move constantly for leave and other commitments, so a stored
fortnightly recurrence was wrong more often than right; that is why
`recurring_note_weeks` is gone and `week` here is a generation week of this
run, bounded in the router against the run's own `num_weeks`.

Three things about this feature are deliberate and easy to get wrong:

1. **Annotation only -- no effect on availability**. Phase 4 still applies
duty and Phase 5 still assigns a clinic to a doctor whose slot carries a
note. A partners meeting occupies the tail of a session, not the session.
Blocking a session entirely is done through the master template
(ADMIN_TIME / NO_SURGERY), as it is today.

2. **Overlapping notes concatenate; they do not collide**. There is no
uniqueness rule across notes -- two instances matching the same
doctor/week/day/period are sorted by id ascending and joined with a
newline. Duplicates are visible in the grid and self-correcting, rather
than a write-time 409 naming a note the user then has to go and find.

3. **No SessionSlot means no note, silently at the data layer**. Phase 2
creates no slot where the doctor has no staged row for that slot, none at
all on a closed date, and none outside a doctor's employment window; an
instance aimed at one of those vanishes. The picker warns on the first two
live as the user edits (it can see the staged sessions and the closed
slots); the window case is an accepted blind spot. Leave is *not* a
suppressor -- Phase 2 builds the slot with `is_on_leave=True`, so a note on
a doctor on leave still appears, which is right for a meeting.

The stamp is a default, not a derived value: grid_utils.rebuild_rota_grid()
reads notes back off the persisted RotaSession row and never re-derives it,
so editing or clearing a note on the draft grid behaves exactly as it does
today, and a cleared note is never restored. Note that instances live and
die with their `RotaConfig`: scrapping a draft discards the picked notes,
exactly as it already discards every staged session edit, and there is no
route that regenerates against an existing config.

Cascade from parent to children is ORM-level (relationship(cascade="all,
delete-orphan")), matching every other parent/child pair in this schema --
there is no DB-level ON DELETE CASCADE anywhere. The `RotaConfig.notes`
relationship is load-bearing rather than tidiness: routers/staging.py's
abandon_staging hard-deletes the staging *and* its RotaConfig, which would
raise an IntegrityError against any picked note without it. doctor_id is a
plain FK to doctors.id with no ondelete, because doctors are soft-deleted
only.
"""
from sqlalchemy import (
    Boolean,
    CheckConstraint,
    ForeignKey,
    Integer,
    String,
    UniqueConstraint,
    true,
)
from sqlalchemy.orm import Mapped, mapped_column, relationship

from ..database import Base
from .enums import Day, Period, enum_col


class RecurringNote(Base):
    """A named meeting in the library, with its default day/period/doctors."""

    __tablename__ = "recurring_notes"

    id: Mapped[int] = mapped_column(primary_key=True)
    text: Mapped[str] = mapped_column(String(200), nullable=False)
    day: Mapped[Day] = mapped_column(enum_col(Day), nullable=False)
    period: Mapped[Period] = mapped_column(enum_col(Period), nullable=False)
    is_active: Mapped[bool] = mapped_column(
        Boolean, nullable=False, default=True, server_default=true()
    )

    doctors: Mapped[list["RecurringNoteDoctor"]] = relationship(
        back_populates="note", cascade="all, delete-orphan"
    )

    def __repr__(self) -> str:  # pragma: no cover
        return f"<RecurringNote {self.text!r} {self.day} {self.period}>"


class RecurringNoteDoctor(Base):
    """One doctor in the definition's default doctor list.

    Scope is an explicit, editable list, not role-based: a new partner
    requires a manual tick.
    """

    __tablename__ = "recurring_note_doctors"
    __table_args__ = (
        UniqueConstraint("note_id", "doctor_id", name="uq_rnd_note_doctor"),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    note_id: Mapped[int] = mapped_column(
        ForeignKey("recurring_notes.id"), nullable=False
    )
    doctor_id: Mapped[int] = mapped_column(ForeignKey("doctors.id"), nullable=False)

    note: Mapped["RecurringNote"] = relationship(back_populates="doctors")
    doctor: Mapped["Doctor"] = relationship()  # type: ignore[name-defined]  # noqa: F821


class RotaConfigNote(Base):
    """One picked (or free-form) note for one run and one generation week.

    `week` is a generation week of this run, not a template week: the check
    constraint only bounds it to the 1-4 the schema allows anywhere, so the
    router bounds it again against the run's `num_weeks` -- a week-3 note on
    a 2-week run is silently dead otherwise, exactly as
    StagingSessionCreateIn already guards.
    """

    __tablename__ = "rota_config_notes"
    __table_args__ = (CheckConstraint("week BETWEEN 1 AND 4", name="ck_rcn_week"),)

    id: Mapped[int] = mapped_column(primary_key=True)
    config_id: Mapped[int] = mapped_column(
        ForeignKey("rota_configs.id"), nullable=False, index=True
    )
    source_note_id: Mapped[int | None] = mapped_column(
        ForeignKey("recurring_notes.id"), nullable=True
    )
    text: Mapped[str] = mapped_column(String(200), nullable=False)
    week: Mapped[int] = mapped_column(Integer, nullable=False)
    day: Mapped[Day] = mapped_column(enum_col(Day), nullable=False)
    period: Mapped[Period] = mapped_column(enum_col(Period), nullable=False)

    doctors: Mapped[list["RotaConfigNoteDoctor"]] = relationship(
        back_populates="note", cascade="all, delete-orphan"
    )

    def __repr__(self) -> str:  # pragma: no cover
        return f"<RotaConfigNote {self.text!r} w{self.week} {self.day} {self.period}>"


class RotaConfigNoteDoctor(Base):
    """One doctor this run's note applies to (copied at pick time)."""

    __tablename__ = "rota_config_note_doctors"
    __table_args__ = (
        UniqueConstraint("config_note_id", "doctor_id", name="uq_rcnd_note_doctor"),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    config_note_id: Mapped[int] = mapped_column(
        ForeignKey("rota_config_notes.id"), nullable=False
    )
    doctor_id: Mapped[int] = mapped_column(ForeignKey("doctors.id"), nullable=False)

    note: Mapped["RotaConfigNote"] = relationship(back_populates="doctors")
    doctor: Mapped["Doctor"] = relationship()  # type: ignore[name-defined]  # noqa: F821
