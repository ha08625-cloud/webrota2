"""RecurringNote and its two child tables (recurring notes plan, Task 1).

A recurring note is a fixed piece of text ("Partners meeting") defined
against a day, a period, a set of template weeks (1-4) and an explicit list
of doctors. Phase 2 stamps it into SessionSlot.notes as a starting value
while it builds the grid; nothing else in the pipeline reads it.

Three things about this feature are deliberate and easy to get wrong:

1. **Annotation only -- no effect on availability** (Design Decision 2).
   Phase 4 still applies duty and Phase 5 still assigns a clinic to a
   doctor whose slot carries a note. A partners meeting occupies the tail
   of a session, not the session. Blocking a session entirely is done
   through the master template (ADMIN_TIME / NO_SURGERY), as it is today.

2. **Overlapping notes concatenate; they do not collide** (Design
   Decision 9). There is no uniqueness rule across notes -- two notes
   matching the same doctor/week/day/period are sorted by note id
   ascending and joined with a newline. Duplicates are visible in the grid
   and self-correcting, rather than a write-time 409 naming a note the
   user then has to go and find.

3. **No template row means no note, silently** (Design Decision 10).
   Phase 2 creates no SessionSlot where the doctor has no master template
   entry for that slot, and none at all on a closed date. A part-time
   doctor with no Tuesday PM row gets no note and no warning. Likewise an
   association to a deactivated doctor is a silent no-op, since Phase 2
   iterates active doctors only (Design Decision 12).

The stamp is a default, not a derived value: grid_utils.rebuild_rota_grid()
reads notes back off the persisted RotaSession row and never re-derives it,
so editing or clearing a note on the draft grid behaves exactly as it does
today, and a cleared note is never restored. Scrap-and-regenerate
re-stamps fresh, like everything else in the pipeline.

Cascade from parent to children is ORM-level (relationship(cascade="all,
delete-orphan")), matching every other parent/child pair in this schema --
there is no DB-level ON DELETE CASCADE anywhere. doctor_id is a plain FK to
doctors.id with no ondelete, because doctors are soft-deleted only.
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
from .enums import Day, Period, enum_col


class RecurringNote(Base):
    __tablename__ = "recurring_notes"

    id: Mapped[int] = mapped_column(primary_key=True)
    text: Mapped[str] = mapped_column(String(200), nullable=False)
    day: Mapped[Day] = mapped_column(enum_col(Day), nullable=False)
    period: Mapped[Period] = mapped_column(enum_col(Period), nullable=False)
    is_active: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)

    doctors: Mapped[list["RecurringNoteDoctor"]] = relationship(
        back_populates="note", cascade="all, delete-orphan"
    )
    weeks: Mapped[list["RecurringNoteWeek"]] = relationship(
        back_populates="note", cascade="all, delete-orphan"
    )

    def __repr__(self) -> str:  # pragma: no cover
        return f"<RecurringNote {self.text!r} {self.day} {self.period}>"


class RecurringNoteDoctor(Base):
    """One doctor the note applies to.

    Scope is an explicit, editable list, not role-based (Design Decision 3):
    a new partner requires a manual tick.
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


class RecurringNoteWeek(Base):
    """One *template* week (1-4) the note applies to.

    Anchoring on template week rather than generation week means a
    fortnightly note lands on the same real-world fortnight as the master
    rota's own cycle, whatever week a run starts on (Design Decision 4).
    There is deliberately no "no rows means every week" shorthand -- at
    least one row is required, and "every week" is all four rows -- which
    keeps the engine lookup branchless and the UI unambiguous.
    """

    __tablename__ = "recurring_note_weeks"
    __table_args__ = (
        CheckConstraint("template_week BETWEEN 1 AND 4", name="ck_rnw_week"),
        UniqueConstraint("note_id", "template_week", name="uq_rnw_note_week"),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    note_id: Mapped[int] = mapped_column(
        ForeignKey("recurring_notes.id"), nullable=False
    )
    template_week: Mapped[int] = mapped_column(Integer, nullable=False)

    note: Mapped["RecurringNote"] = relationship(back_populates="weeks")