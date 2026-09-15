"""Research studies: CRUD, the stage machine, and the setup checklist.

**The stage machine is one step at a time, in either direction.** There is
no `stage` field on `StudyPatch`; `POST /advance` and `POST /revert` are the
only ways the column moves, and each 409s at the end it is being pushed
past. Two endpoints rather than a settable field because the *transition* is
the domain action, because a body-supplied stage invites a jump, and because
a revert deserves its own audit sentence and its own confirmation copy
rather than looking like an edit. The next and previous stages are read off
`STUDY_STAGE_ORDER`, so a fifth stage is an edit there and a migration, not
a hunt through this file.

**The checklist never blocks a transition.** Nothing here consults the setup
steps when advancing: a hard gate on eight ticks teaches people to tick
things they have not done. The frontend's confirmation dialog names what is
outstanding, computed from data it already holds.

**Setup step rows are created lazily.** A study starts with none, and the
first PATCH to a step upserts one under the unique `(study_id, step_key)`.
The upsert catches `IntegrityError` and re-selects rather than 500ing, which
is what that constraint is for: two people ticking the same box at the same
moment is a race one of them must lose quietly.

**Delete is Setup-only.** A study created by mistake is real and needs a way
out; a study that ever recruited is a record and is closed, not deleted. The
409 outside Setup is the whole of that rule -- there is no `deleted_at`
column, because filtering one in every query forever is a poor trade for a
case that only happens on the day a study is created.

Contacts have no endpoints. They are sent inside the study PATCH as a full
replace, so `{"contacts": [...]}` means "these are now all the contacts" and
an absent key means "leave them alone".

Gating is entirely at registration time (main.py puts both modules in the
`research` area), so nothing in this file gates itself. Research is not in
`LOCKABLE_AREAS`: the section lock exists because two people editing one
shared rota grid overwrite each other, and locking a whole section so one
person can tick a box would be worse than the collision it prevents.
"""
from __future__ import annotations

import datetime

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session, joinedload, selectinload

from ....models.enums import STUDY_STAGE_ORDER, StudyStage
from ....models.user import User
from ....research.catalogue import SETUP_STEPS_BY_KEY, is_valid_step
from ....research.models import Study, StudyContact, StudyDocument, StudySetupStep
from ....research.schemas import (
    SetupStepPatch,
    StudyIn,
    StudyOut,
    StudyPatch,
)
from ...deps import get_current_user, get_db

router = APIRouter(prefix="/research/studies", tags=["research"])

# Which nullable date column records entry into which stage. Written once
# here rather than branched on at each transition, for the same reason
# STUDY_STAGE_ORDER exists: a fifth stage should be two lines and a
# migration.
_STAGE_ENTERED_COLUMN: dict[StudyStage, str] = {
    StudyStage.SETUP: "setup_entered_on",
    StudyStage.RECRUITMENT_OPEN: "recruitment_opened_on",
    StudyStage.RECRUITMENT_CLOSED: "recruitment_closed_on",
    StudyStage.CLOSED: "closed_on",
}


def _study_query():
    """A study with its children eagerly loaded and the blobs left behind.

    `defer(StudyDocument.data)` is not an optimisation to taste: every study
    response lists its documents, and without it a study page load would
    pull every stored file's bytes out of the database to serialise their
    filenames.
    """
    return select(Study).options(
        joinedload(Study.owner),
        selectinload(Study.contacts),
        selectinload(Study.setup_steps),
        selectinload(Study.documents).defer(StudyDocument.data),
    )


def _load_or_404(db: Session, study_id: int) -> Study:
    study = db.execute(
        _study_query().where(Study.id == study_id)
    ).unique().scalar_one_or_none()
    if study is None:
        raise HTTPException(status_code=404, detail=f"Study {study_id} not found")
    return study


def _to_out(study: Study) -> StudyOut:
    """Serialise, ordering the two unordered collections and dropping steps
    the catalogue no longer knows about.

    Those orphans are the documented cost of `step_key` being a checked
    string rather than an enum type (see research/catalogue.py): dropping a
    step from the catalogue needs no migration, and the rows it leaves
    behind are simply never rendered again. Filtering here is what makes
    that true for every reader at once.
    """
    out = StudyOut.model_validate(study)
    out.owner_name = study.owner.name if study.owner is not None else None
    out.setup_steps = sorted(
        (step for step in out.setup_steps if step.step_key in SETUP_STEPS_BY_KEY),
        key=lambda step: SETUP_STEPS_BY_KEY[step.step_key].display_order,
    )
    out.documents.sort(key=lambda doc: (doc.slot, doc.uploaded_at, doc.id))
    return out


def _check_cpms_code_free(
    db: Session, cpms_code: str | None, *, exclude_study_id: int | None = None
) -> None:
    """409 rather than the 500 a unique-index violation would otherwise be.

    Checked here AND caught as an IntegrityError at the write (see the two
    call sites): this select answers with the right status and a sentence
    naming the other study, and the catch covers the race between the two.
    """
    if cpms_code is None:
        return
    query = select(Study).where(Study.cpms_code == cpms_code)
    if exclude_study_id is not None:
        query = query.where(Study.id != exclude_study_id)
    clash = db.execute(query).scalars().first()
    if clash is not None:
        raise HTTPException(
            status_code=409,
            detail=f"CPMS code {cpms_code} is already used by {clash.name}",
        )


def _cpms_conflict(cpms_code: str | None) -> HTTPException:
    """The race the select above cannot close, rendered as the same 409."""
    return HTTPException(
        status_code=409,
        detail=f"CPMS code {cpms_code} is already used by another study",
    )


def _replace_contacts(study: Study, contacts) -> None:
    """Full replace, renumbering `display_order` from the sent order.

    delete-orphan on the relationship is what removes the old rows; the list
    the client sent is the whole truth about who to ring.
    """
    study.contacts.clear()
    for index, contact in enumerate(contacts):
        study.contacts.append(
            StudyContact(
                name=contact.name,
                role=contact.role,
                email=contact.email,
                phone=contact.phone,
                display_order=index,
            )
        )


@router.get("", response_model=list[StudyOut])
def list_studies(
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
) -> list[StudyOut]:
    """Every study, wholesale -- no search and no pagination, per the
    app-wide convention for reference data. A practice runs a dozen studies;
    the list page groups them by stage and collapses Closed, which is the
    only affordance that size needs."""
    studies = db.execute(
        _study_query().order_by(Study.name, Study.id)
    ).unique().scalars().all()
    return [_to_out(study) for study in studies]


@router.post("", response_model=StudyOut, status_code=201)
def create_study(
    payload: StudyIn,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
) -> StudyOut:
    _check_cpms_code_free(db, payload.cpms_code)
    study = Study(
        name=payload.name,
        cpms_code=payload.cpms_code,
        study_type=payload.study_type,
        website_url=payload.website_url,
        owner_user_id=payload.owner_user_id,
        stage=StudyStage.SETUP,
        # Every stage records the date it was entered, and setup is a stage.
        setup_entered_on=datetime.date.today(),
    )
    _replace_contacts(study, payload.contacts)
    db.add(study)
    try:
        db.commit()
    except IntegrityError as exc:
        db.rollback()
        raise _cpms_conflict(payload.cpms_code) from exc
    return _to_out(_load_or_404(db, study.id))


@router.get("/{study_id}", response_model=StudyOut)
def get_study(
    study_id: int,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
) -> StudyOut:
    return _to_out(_load_or_404(db, study_id))


@router.patch("/{study_id}", response_model=StudyOut)
def update_study(
    study_id: int,
    payload: StudyPatch,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
) -> StudyOut:
    study = _load_or_404(db, study_id)
    sent = payload.model_fields_set

    if "cpms_code" in sent:
        _check_cpms_code_free(db, payload.cpms_code, exclude_study_id=study_id)

    for field in ("name", "cpms_code", "study_type", "website_url", "owner_user_id"):
        if field in sent:
            setattr(study, field, getattr(payload, field))

    if "contacts" in sent:
        _replace_contacts(study, payload.contacts or [])

    try:
        db.commit()
    except IntegrityError as exc:
        db.rollback()
        raise _cpms_conflict(payload.cpms_code) from exc
    return _to_out(_load_or_404(db, study_id))


@router.delete("/{study_id}", status_code=204)
def delete_study(
    study_id: int,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
) -> None:
    """Setup only. Everything hanging off the study goes with it, by the
    ORM-level cascades on the relationships."""
    study = _load_or_404(db, study_id)
    if study.stage is not StudyStage.SETUP:
        raise HTTPException(
            status_code=409,
            detail=(
                "Only a study still in setup can be deleted. A study that has "
                "reached recruitment is a record -- close it instead."
            ),
        )
    db.delete(study)
    db.commit()


@router.patch("/{study_id}/setup-steps/{step_key}", response_model=StudyOut)
def update_setup_step(
    study_id: int,
    step_key: str,
    payload: SetupStepPatch,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
) -> StudyOut:
    """Tick, date or annotate one checklist line, creating its row if this
    is the first write to it.

    Returns the whole study rather than the one step: the page shows the
    checklist beside the header and the documents, and one response keeps
    the client's copy of all three in step.
    """
    _load_or_404(db, study_id)
    if not is_valid_step(step_key):
        raise HTTPException(
            status_code=422, detail=f"{step_key} is not a setup step"
        )

    step = db.execute(
        select(StudySetupStep).where(
            StudySetupStep.study_id == study_id,
            StudySetupStep.step_key == step_key,
        )
    ).scalar_one_or_none()

    if step is None:
        step = StudySetupStep(study_id=study_id, step_key=step_key, done=False)
        db.add(step)
        try:
            db.flush()
        except IntegrityError:
            # Somebody else created the same row between the select and the
            # flush. The unique constraint is doing its job; re-read theirs
            # and apply this request's fields on top.
            db.rollback()
            step = db.execute(
                select(StudySetupStep).where(
                    StudySetupStep.study_id == study_id,
                    StudySetupStep.step_key == step_key,
                )
            ).scalar_one()

    sent = payload.model_fields_set
    for field in ("done", "done_on", "note"):
        if field in sent:
            setattr(step, field, getattr(payload, field))
    # `done` is non-nullable; an explicit null means "untick" rather than
    # a column the database will refuse.
    if step.done is None:
        step.done = False

    db.commit()
    return _to_out(_load_or_404(db, study_id))


def _move(db: Session, study: Study, offset: int) -> StudyOut:
    index = STUDY_STAGE_ORDER.index(study.stage)
    target = index + offset
    if not 0 <= target < len(STUDY_STAGE_ORDER):
        raise HTTPException(
            status_code=409,
            detail=(
                f"This study is already at {study.stage.value} -- there is no "
                f"{'next' if offset > 0 else 'previous'} stage."
            ),
        )
    study.stage = STUDY_STAGE_ORDER[target]
    # Entering a stage records today, including on the way back: reverting
    # into setup is a re-entry like any other, and the four dates read the
    # same way because of it. No stage's data is deleted on leaving it, so
    # a revert restores the page as it was -- which is what makes moving
    # backwards safe rather than destructive.
    setattr(study, _STAGE_ENTERED_COLUMN[study.stage], datetime.date.today())
    db.commit()
    return _to_out(_load_or_404(db, study.id))


@router.post("/{study_id}/advance", response_model=StudyOut)
def advance_study(
    study_id: int,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
) -> StudyOut:
    """One stage forward. 409 at `closed`."""
    return _move(db, _load_or_404(db, study_id), 1)


@router.post("/{study_id}/revert", response_model=StudyOut)
def revert_study(
    study_id: int,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
) -> StudyOut:
    """One stage back, for the misclick that would otherwise need a database
    edit. 409 at `setup`."""
    return _move(db, _load_or_404(db, study_id), -1)
