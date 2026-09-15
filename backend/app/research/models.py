"""Research study models: the study, its contacts, its setup steps and its
documents.

Domain-first placement (`app/research/models.py`, not `app/models/study.py`)
per "Adding a Module" in `documentation/architecture.md`. Two consequences
that are easy to get wrong:

- `app/models/__init__.py` still imports these classes, because `create_all`
  and Alembic autogenerate rely on importing that one package to register
  every mapper -- and the test suite builds its SQLite database from the
  models. Living outside `app/models/` does not mean an unregistered mapper.
- The imports below name the **submodules** (`..database`, `..models.enums`),
  never the `app.models` aggregate. The aggregate imports this module while
  it is still initialising, so going back through it is a circular import
  waiting on whichever name happens to be bound after ours; and the import
  contracts are direct-import only, so an aggregate reference would be
  invisible to them.

**One `stage` column, four dates beside it.** The stage is a single enum
value (see `StudyStage`), and each stage records the date it was entered in
its own nullable column. "When did recruitment open?" is a question worth
answering; "how many times did somebody bounce this study between stages?"
is not, and the audit log answers it for free if it is ever asked -- so
there is no stage-history table. Moving a stage backwards is supported (a
misclick should not need a database edit), which is safe precisely because
no stage's data is ever deleted on leaving it: setup data is *hidden* in
later stages, so reverting restores the page as it was.

**Cleanup is ORM-level** (`cascade="all, delete-orphan"` on all three child
relationships), matching every other parent/child pair in this schema. The
one DB-level `ON DELETE CASCADE` in the whole database is
`school_holidays.school_id`; it is the exception, not the convention. Note
that deletion is only ever reachable while a study is in setup -- a study
that ever recruited is a record and is closed, not deleted -- so these
cascades run on the day a study is created by mistake and essentially never
again.

**Both FKs to `users` are deliberately left at the database's default
no-action (i.e. RESTRICT) behaviour, not `SET NULL`.** Users in this app are
deactivated, never deleted, so a delete that would orphan a study owner or
a document's uploader is a mistake worth failing on rather than quietly
blanking the column. No `ondelete` clause is emitted, in keeping with the
rest of the schema; RESTRICT is what "no clause" already means on both
Postgres and SQLite.

**`study_documents` holds bytes in the database**, as `DoctorSignature`
already does and for the same reason: Railway runs one service with an
ephemeral container filesystem, so bytea is a constraint rather than a
preference, and adding object storage for a few dozen small PDFs is not a
trade worth making. It also means these rows are in the same backups as the
rota, which is the other half of why the section refuses to become a
document store.
"""
import datetime

from sqlalchemy import (
    Boolean,
    Date,
    DateTime,
    ForeignKey,
    Index,
    Integer,
    LargeBinary,
    String,
    UniqueConstraint,
)
from sqlalchemy.orm import Mapped, mapped_column, relationship

from ..database import Base
from ..models.enums import StudyStage, enum_col


class Study(Base):
    """One research study the practice is a recruitment site for.

    `cpms_code` is uniquely indexed but nullable: a study in early setup may
    not have one yet, and both SQLite and Postgres treat NULLs as distinct
    in a unique index, so any number of studies may sit without a code while
    no two can claim the same one.

    `study_type` is free text rather than an enum. The taxonomy is set
    outside this practice and changes; a free string costs no migration to
    widen, and nothing in the app branches on the value.

    `website_url` is validated at the schema layer to `http`/`https` only,
    and rendered with `rel="noopener noreferrer"`. That validation is not
    cosmetic: a stored `javascript:` URL rendered as a link is a stored-XSS
    hole. The column itself is a plain string -- the check belongs where the
    value enters, not in a CHECK constraint that could only repeat it badly.
    """

    __tablename__ = "studies"
    __table_args__ = (
        Index("uq_studies_cpms_code", "cpms_code", unique=True),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    name: Mapped[str] = mapped_column(String, nullable=False)
    cpms_code: Mapped[str | None] = mapped_column(String, nullable=True)
    study_type: Mapped[str | None] = mapped_column(String, nullable=True)
    website_url: Mapped[str | None] = mapped_column(String, nullable=True)
    owner_user_id: Mapped[int | None] = mapped_column(
        ForeignKey("users.id"), nullable=True
    )
    stage: Mapped[StudyStage] = mapped_column(
        enum_col(StudyStage),
        nullable=False,
        default=StudyStage.SETUP,
        server_default=StudyStage.SETUP.value,
    )
    # One date per stage, set when that stage is entered and left alone
    # afterwards. `setup_entered_on` duplicates the date part of
    # `created_at` for a study that has never moved, and exists anyway so
    # the four read the same way and so that reverting into setup records
    # the re-entry like every other transition.
    setup_entered_on: Mapped[datetime.date | None] = mapped_column(Date, nullable=True)
    recruitment_opened_on: Mapped[datetime.date | None] = mapped_column(
        Date, nullable=True
    )
    recruitment_closed_on: Mapped[datetime.date | None] = mapped_column(
        Date, nullable=True
    )
    closed_on: Mapped[datetime.date | None] = mapped_column(Date, nullable=True)
    created_at: Mapped[datetime.datetime] = mapped_column(
        DateTime(timezone=True),
        nullable=False,
        default=lambda: datetime.datetime.now(datetime.timezone.utc),
    )

    # No back_populates: nothing on User needs to navigate to the studies it
    # owns, and a back-reference would put a research-shaped attribute on
    # the identity table.
    owner: Mapped["User | None"] = relationship()  # type: ignore[name-defined]  # noqa: F821

    contacts: Mapped[list["StudyContact"]] = relationship(
        back_populates="study",
        cascade="all, delete-orphan",
        order_by="StudyContact.display_order",
    )
    setup_steps: Mapped[list["StudySetupStep"]] = relationship(
        back_populates="study", cascade="all, delete-orphan"
    )
    documents: Mapped[list["StudyDocument"]] = relationship(
        back_populates="study", cascade="all, delete-orphan"
    )

    def __repr__(self) -> str:  # pragma: no cover
        return f"<Study {self.name!r} ({self.stage.value})>"


class StudyContact(Base):
    """Who to ring about this study.

    A child table rather than a free-text blob because scanning "who do I
    contact" is exactly the one-glance job the study page exists for. Every
    field except the name is optional -- a contact often arrives as a name
    and an email and nothing else.

    Contacts have no endpoints of their own: they are edited inside the
    study edit dialog and saved as a full replace on the study PATCH, which
    is why `display_order` is a plain integer written by that replace rather
    than anything the rows maintain themselves.
    """

    __tablename__ = "study_contacts"

    id: Mapped[int] = mapped_column(primary_key=True)
    study_id: Mapped[int] = mapped_column(
        ForeignKey("studies.id"), nullable=False, index=True
    )
    name: Mapped[str] = mapped_column(String, nullable=False)
    role: Mapped[str | None] = mapped_column(String, nullable=True)
    email: Mapped[str | None] = mapped_column(String, nullable=True)
    phone: Mapped[str | None] = mapped_column(String, nullable=True)
    display_order: Mapped[int] = mapped_column(Integer, nullable=False, default=0)

    study: Mapped["Study"] = relationship(back_populates="contacts")

    def __repr__(self) -> str:  # pragma: no cover
        return f"<StudyContact {self.name!r} study_id={self.study_id}>"


class StudySetupStep(Base):
    """One ticked (or unticked) line of a study's setup checklist.

    **Rows are created lazily and their absence is data.** A new study has
    none; the first write to a step upserts one under the unique
    `(study_id, step_key)` below, and a step with no row renders as "not
    done". The upsert is what that constraint is for -- two concurrent
    writes to the same step must lose the race with an `IntegrityError` the
    router catches and re-selects on, not with a duplicate row.

    `step_key` is a checked string, not an enum type: it is validated
    against `catalogue.SETUP_STEPS_BY_KEY` on write, so the catalogue can
    gain or lose a step without a migration. A key dropped from the
    catalogue leaves rows here that are never rendered again, which is the
    intended cost of that.

    `done_on` is the date the step was completed, entered by hand -- not a
    timestamp of when the box was ticked, which is the audit log's job.
    """

    __tablename__ = "study_setup_steps"
    __table_args__ = (
        UniqueConstraint("study_id", "step_key", name="uq_study_setup_steps_study_step"),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    study_id: Mapped[int] = mapped_column(
        ForeignKey("studies.id"), nullable=False, index=True
    )
    step_key: Mapped[str] = mapped_column(String, nullable=False)
    done: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    done_on: Mapped[datetime.date | None] = mapped_column(Date, nullable=True)
    note: Mapped[str | None] = mapped_column(String, nullable=True)

    study: Mapped["Study"] = relationship(back_populates="setup_steps")

    def __repr__(self) -> str:  # pragma: no cover
        return f"<StudySetupStep {self.step_key} study_id={self.study_id} done={self.done}>"


class StudyDocument(Base):
    """A file attached to a study, in a named slot.

    `slot` is non-nullable and validated against `catalogue.DOCUMENT_SLOTS`
    on write: there is no "general study document" and no folder, because a
    file that fits no slot belongs on the intranet. Whether a slot holds one
    file or many is `catalogue.slot_holds_one`, enforced by the router in
    one transaction -- see that function for why it is not a partial unique
    index.

    `content_type` is client-supplied and is not evidence of anything: the
    upload route checks it *and* the filename extension against the
    allowlist, and downloads echo it back only when it is still in that
    allowlist. The real protection is the download response headers
    (`Content-Disposition: attachment`, `X-Content-Type-Options: nosniff`),
    because these files are served from the app's own origin.

    `size_bytes` is stored beside the blob so the list view can show a size
    without loading the bytes -- `data` is a `LargeBinary` and every query
    that does not need it should defer it.

    `uploaded_at` has no default at either level, following
    `DoctorSignature`: the upload router sets it explicitly at write time,
    so the value always comes from the request.
    """

    __tablename__ = "study_documents"

    id: Mapped[int] = mapped_column(primary_key=True)
    study_id: Mapped[int] = mapped_column(
        ForeignKey("studies.id"), nullable=False, index=True
    )
    slot: Mapped[str] = mapped_column(String, nullable=False)
    filename: Mapped[str] = mapped_column(String, nullable=False)
    content_type: Mapped[str] = mapped_column(String, nullable=False)
    size_bytes: Mapped[int] = mapped_column(Integer, nullable=False)
    data: Mapped[bytes] = mapped_column(LargeBinary, nullable=False)
    uploaded_at: Mapped[datetime.datetime] = mapped_column(
        DateTime(timezone=True), nullable=False
    )
    uploaded_by_user_id: Mapped[int | None] = mapped_column(
        ForeignKey("users.id"), nullable=True
    )

    study: Mapped["Study"] = relationship(back_populates="documents")
    uploaded_by: Mapped["User | None"] = relationship()  # type: ignore[name-defined]  # noqa: F821

    def __repr__(self) -> str:  # pragma: no cover
        return f"<StudyDocument {self.slot}:{self.filename!r} study_id={self.study_id}>"
