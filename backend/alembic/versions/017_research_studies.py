"""research studies, contacts, setup steps and documents

Revision ID: 017
Revises: 016
Create Date: 2026-09-15 00:00:00

The Research section's schema: four tables and one new native enum type.
016 added the `research` permission key; this adds the data it gates. See
`app/research/` for what the section is and, more importantly, what it
deliberately is not -- the intranet remains the record, and this is a
signpost to it.

`studies` carries the identifying information that persists for a study's
whole life plus a single `stage` column, and one nullable date per stage
recording when that stage was entered. One enum column, never four
booleans: the stages are mutually exclusive, so a shape that can represent
"recruitment open and closed at once" is a shape somebody will eventually
save. There is no stage-history table -- "when did recruitment open?" is a
question, "how many times was this bounced between stages?" is not, and the
audit log already answers the second one.

`study_setup_steps` is created empty and stays empty until somebody ticks
something: rows are upserted lazily and a missing row means "not done", so
there is nothing to seed here and nothing to backfill when the checklist
gains a ninth step. `step_key` is a plain string validated against
`app/research/catalogue.py` on write, not an enum type, for exactly that
reason. The unique `(study_id, step_key)` is what makes the upsert safe
under two concurrent writes.

`study_documents` stores file bytes in the database (bytea on Postgres),
following `doctor_signatures` -- Railway runs one service with an ephemeral
container filesystem, so this is a constraint rather than a preference.
`slot` is non-nullable: there is no "general" document and no folder.

Cascades stay ORM-level, as everywhere else in this schema; no ON DELETE is
introduced here. Both FKs to `users` are left at the default no-action
(RESTRICT) behaviour rather than SET NULL: users in this app are
deactivated and never deleted, so a delete that would orphan a study owner
or a document's uploader should fail rather than silently blank the column.

The `study_stage` type is new, so unlike 012 this migration has to create
it. It follows 001's `_enum()` / `_create_enum_types()` pattern -- the type
created once, explicitly, at the top of upgrade(), with the column
referencing it without re-emitting CREATE TYPE -- even though only one
column uses it today, so that a second column later needs no restructuring.
The downgrade drops the type explicitly after the tables, which a plain
`drop_table` does not do.

Only Postgres needs this migration -- CI runs `alembic upgrade head` /
`downgrade base` against it, while the test suite builds SQLite straight
from the models via `create_all`.

Downgrade drops all four tables and the enum type. It is destructive and
says so: every study, its documents and its checklist go with it. The
system is not live for this section, so there is no data to preserve.
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

from app.models.enums import StudyStage, _snake

revision: str = "017"
down_revision: Union[str, None] = "016"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

_NEW_ENUMS = (StudyStage,)


def _values(py_enum):
    return [member.value for member in py_enum]


def _enum(py_enum):
    """Column type for a Python enum, matching 001's helper.

    On Postgres the named type is created once by `_create_enum_types`
    below, so the column must reference it without re-emitting CREATE TYPE.
    """
    name = _snake(py_enum.__name__)
    if op.get_bind().dialect.name == "postgresql":
        return postgresql.ENUM(
            py_enum, name=name, create_type=False, values_callable=_values
        )
    return sa.Enum(py_enum, name=name, values_callable=_values)


def _create_enum_types() -> None:
    bind = op.get_bind()
    if bind.dialect.name != "postgresql":
        return
    for py_enum in _NEW_ENUMS:
        postgresql.ENUM(
            py_enum, name=_snake(py_enum.__name__), values_callable=_values
        ).create(bind, checkfirst=True)


def _drop_enum_types() -> None:
    bind = op.get_bind()
    if bind.dialect.name != "postgresql":
        return
    for py_enum in _NEW_ENUMS:
        postgresql.ENUM(
            py_enum, name=_snake(py_enum.__name__), values_callable=_values
        ).drop(bind, checkfirst=True)


def upgrade() -> None:
    _create_enum_types()

    op.create_table(
        "studies",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("name", sa.String(), nullable=False),
        sa.Column("cpms_code", sa.String(), nullable=True),
        sa.Column("study_type", sa.String(), nullable=True),
        sa.Column("website_url", sa.String(), nullable=True),
        sa.Column(
            "owner_user_id", sa.Integer(), sa.ForeignKey("users.id"), nullable=True
        ),
        sa.Column(
            "stage",
            _enum(StudyStage),
            nullable=False,
            server_default=StudyStage.SETUP.value,
        ),
        sa.Column("setup_entered_on", sa.Date(), nullable=True),
        sa.Column("recruitment_opened_on", sa.Date(), nullable=True),
        sa.Column("recruitment_closed_on", sa.Date(), nullable=True),
        sa.Column("closed_on", sa.Date(), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
    )
    # Unique, and nullable: a study in early setup may not have a CPMS code
    # yet, and both Postgres and SQLite treat NULLs as distinct here.
    op.create_index("uq_studies_cpms_code", "studies", ["cpms_code"], unique=True)

    op.create_table(
        "study_contacts",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column(
            "study_id", sa.Integer(), sa.ForeignKey("studies.id"), nullable=False
        ),
        sa.Column("name", sa.String(), nullable=False),
        sa.Column("role", sa.String(), nullable=True),
        sa.Column("email", sa.String(), nullable=True),
        sa.Column("phone", sa.String(), nullable=True),
        sa.Column("display_order", sa.Integer(), nullable=False),
    )
    op.create_index("ix_study_contacts_study_id", "study_contacts", ["study_id"])

    op.create_table(
        "study_setup_steps",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column(
            "study_id", sa.Integer(), sa.ForeignKey("studies.id"), nullable=False
        ),
        sa.Column("step_key", sa.String(), nullable=False),
        sa.Column("done", sa.Boolean(), nullable=False),
        sa.Column("done_on", sa.Date(), nullable=True),
        sa.Column("note", sa.String(), nullable=True),
        sa.UniqueConstraint(
            "study_id", "step_key", name="uq_study_setup_steps_study_step"
        ),
    )
    op.create_index("ix_study_setup_steps_study_id", "study_setup_steps", ["study_id"])

    op.create_table(
        "study_documents",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column(
            "study_id", sa.Integer(), sa.ForeignKey("studies.id"), nullable=False
        ),
        sa.Column("slot", sa.String(), nullable=False),
        sa.Column("filename", sa.String(), nullable=False),
        sa.Column("content_type", sa.String(), nullable=False),
        sa.Column("size_bytes", sa.Integer(), nullable=False),
        sa.Column("data", sa.LargeBinary(), nullable=False),
        sa.Column("uploaded_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column(
            "uploaded_by_user_id",
            sa.Integer(),
            sa.ForeignKey("users.id"),
            nullable=True,
        ),
    )
    op.create_index("ix_study_documents_study_id", "study_documents", ["study_id"])


def downgrade() -> None:
    op.drop_index("ix_study_documents_study_id", table_name="study_documents")
    op.drop_table("study_documents")
    op.drop_index("ix_study_setup_steps_study_id", table_name="study_setup_steps")
    op.drop_table("study_setup_steps")
    op.drop_index("ix_study_contacts_study_id", table_name="study_contacts")
    op.drop_table("study_contacts")
    op.drop_index("uq_studies_cpms_code", table_name="studies")
    op.drop_table("studies")
    _drop_enum_types()
