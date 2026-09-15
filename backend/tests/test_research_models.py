"""Research model tests: round-trips, the two uniqueness rules, the three
cascades, and the FK behaviour the section's user links depend on.

A new module rather than an addition to test_models.py because that file is
a module, not a package, and research is a section of its own -- the same
split the backend now makes everywhere else.

Two FK traps this repo has hit before are exercised here on purpose: the
test engine enables `PRAGMA foreign_keys=ON`, and a `Study.owner_user_id`
or `StudyDocument.uploaded_by_user_id` therefore needs a real seeded user
row, not just an id.
"""
import datetime

import pytest
from sqlalchemy.exc import IntegrityError

from app.models import Study, StudyContact, StudyDocument, StudySetupStep, User
from app.models.enums import AccessLevel, StudyStage


def _user(session, email="researcher@example.com"):
    u = User(
        email=email,
        name="Research Nurse",
        password_hash="x",
        access_level=AccessLevel.NURSE,
        active=True,
    )
    session.add(u)
    session.flush()
    return u


def _study(session, name="ACME-1", **kwargs):
    s = Study(name=name, **kwargs)
    session.add(s)
    session.flush()
    return s


def _document(study, slot="flow_chart", filename="flow.pdf", **kwargs):
    return StudyDocument(
        study_id=study.id,
        slot=slot,
        filename=filename,
        content_type=kwargs.pop("content_type", "application/pdf"),
        size_bytes=kwargs.pop("size_bytes", 3),
        data=kwargs.pop("data", b"pdf"),
        uploaded_at=kwargs.pop(
            "uploaded_at", datetime.datetime(2026, 9, 1, 9, 0, tzinfo=datetime.timezone.utc)
        ),
        **kwargs,
    )


# --- Study ---

def test_study_round_trip(session):
    owner = _user(session)
    study = _study(
        session,
        name="CANDID",
        cpms_code="12345",
        study_type="Interventional",
        website_url="https://example.org/candid",
        owner_user_id=owner.id,
        setup_entered_on=datetime.date(2026, 9, 1),
    )
    session.commit()
    session.expire_all()

    loaded = session.get(Study, study.id)
    assert loaded.name == "CANDID"
    assert loaded.cpms_code == "12345"
    assert loaded.study_type == "Interventional"
    assert loaded.website_url == "https://example.org/candid"
    assert loaded.owner.email == "researcher@example.com"
    assert loaded.setup_entered_on == datetime.date(2026, 9, 1)
    assert loaded.created_at is not None


def test_study_defaults_to_setup_with_no_stage_dates(session):
    """A new study is in setup and has recorded no transitions yet -- the
    four stage-entry dates are filled in by the transition endpoints, not at
    create time."""
    study = _study(session)
    session.flush()

    assert study.stage is StudyStage.SETUP
    assert study.setup_entered_on is None
    assert study.recruitment_opened_on is None
    assert study.recruitment_closed_on is None
    assert study.closed_on is None


def test_study_stage_round_trips_through_every_value(session):
    for stage in StudyStage:
        study = _study(session, name=f"study-{stage.value}", stage=stage)
        session.commit()
        session.expire_all()
        assert session.get(Study, study.id).stage is stage


def test_cpms_code_is_unique(session):
    _study(session, name="A", cpms_code="99999")
    session.add(Study(name="B", cpms_code="99999"))
    with pytest.raises(IntegrityError):
        session.flush()


def test_cpms_code_allows_many_nulls(session):
    """A study in early setup may not have a CPMS code yet, and several may
    be in that state at once -- both SQLite and Postgres treat NULLs as
    distinct under a unique index."""
    _study(session, name="A")
    _study(session, name="B")
    _study(session, name="C", cpms_code=None)
    session.commit()

    assert session.query(Study).count() == 3


def test_owner_user_id_must_reference_a_real_user(session):
    session.add(Study(name="Orphan", owner_user_id=4242))
    with pytest.raises(IntegrityError):
        session.flush()


def test_deleting_a_user_with_studies_is_refused(session):
    """RESTRICT, not SET NULL: users are deactivated and never deleted in
    this app, so a delete that would orphan a study owner is a mistake worth
    failing on."""
    owner = _user(session)
    _study(session, owner_user_id=owner.id)
    session.flush()

    session.delete(owner)
    with pytest.raises(IntegrityError):
        session.flush()


# --- StudyContact ---

def test_contacts_round_trip_in_display_order(session):
    study = _study(session)
    session.add_all(
        [
            StudyContact(
                study_id=study.id, name="Second", role="Monitor", display_order=1
            ),
            StudyContact(
                study_id=study.id,
                name="First",
                role="CRA",
                email="cra@example.org",
                phone="01865 000000",
                display_order=0,
            ),
        ]
    )
    session.commit()
    session.expire_all()

    contacts = session.get(Study, study.id).contacts
    assert [c.name for c in contacts] == ["First", "Second"]
    assert contacts[0].email == "cra@example.org"
    assert contacts[0].phone == "01865 000000"
    assert contacts[1].email is None


def test_contacts_cascade_on_study_delete(session):
    study = _study(session)
    session.add(StudyContact(study_id=study.id, name="CRA", display_order=0))
    session.flush()

    session.delete(study)
    session.flush()

    assert session.query(StudyContact).filter_by(study_id=study.id).all() == []


# --- StudySetupStep ---

def test_setup_step_round_trip(session):
    study = _study(session)
    session.add(
        StudySetupStep(
            study_id=study.id,
            step_key="mnca",
            done=True,
            done_on=datetime.date(2026, 9, 3),
            note="Signed by the partners",
        )
    )
    session.commit()
    session.expire_all()

    step = session.query(StudySetupStep).filter_by(study_id=study.id).one()
    assert step.step_key == "mnca"
    assert step.done is True
    assert step.done_on == datetime.date(2026, 9, 3)
    assert step.note == "Signed by the partners"


def test_a_new_study_has_no_setup_step_rows(session):
    """Rows are upserted lazily by the first write to a step; a missing row
    renders as "not done"."""
    study = _study(session)
    session.commit()

    assert study.setup_steps == []


def test_setup_step_is_unique_per_study_and_key(session):
    study = _study(session)
    session.add(StudySetupStep(study_id=study.id, step_key="mnca", done=True))
    session.flush()

    session.add(StudySetupStep(study_id=study.id, step_key="mnca", done=False))
    with pytest.raises(IntegrityError):
        session.flush()


def test_same_step_key_on_two_studies_is_fine(session):
    first = _study(session, name="A")
    second = _study(session, name="B")
    session.add_all(
        [
            StudySetupStep(study_id=first.id, step_key="mnca", done=True),
            StudySetupStep(study_id=second.id, step_key="mnca", done=True),
        ]
    )
    session.commit()

    assert session.query(StudySetupStep).count() == 2


def test_setup_steps_cascade_on_study_delete(session):
    study = _study(session)
    session.add(StudySetupStep(study_id=study.id, step_key="siv_booked", done=True))
    session.flush()

    session.delete(study)
    session.flush()

    assert session.query(StudySetupStep).filter_by(study_id=study.id).all() == []


# --- StudyDocument ---

def test_document_round_trip(session):
    uploader = _user(session)
    study = _study(session)
    session.add(
        _document(
            study,
            slot="patient_information_leaflet",
            filename="PIS v3.pdf",
            data=b"%PDF-1.7 blank leaflet",
            size_bytes=22,
            uploaded_by_user_id=uploader.id,
        )
    )
    session.commit()
    session.expire_all()

    doc = session.query(StudyDocument).filter_by(study_id=study.id).one()
    assert doc.slot == "patient_information_leaflet"
    assert doc.filename == "PIS v3.pdf"
    assert doc.content_type == "application/pdf"
    assert doc.size_bytes == 22
    assert doc.data == b"%PDF-1.7 blank leaflet"
    assert doc.uploaded_at.year == 2026
    assert doc.uploaded_by.email == uploader.email


def test_document_slot_is_required(session):
    study = _study(session)
    session.add(_document(study, slot=None))
    with pytest.raises(IntegrityError):
        session.flush()


def test_a_step_slot_may_hold_several_documents(session):
    """The many-file slots are not constrained in the schema: single-file
    behaviour on the three key slots is a router rule, not an index (see
    catalogue.slot_holds_one)."""
    study = _study(session)
    session.add_all(
        [
            _document(study, slot="mnca", filename="mNCA signed.pdf"),
            _document(study, slot="mnca", filename="mNCA re-signed.pdf"),
        ]
    )
    session.commit()

    assert session.query(StudyDocument).filter_by(slot="mnca").count() == 2


def test_uploaded_by_user_id_must_reference_a_real_user(session):
    study = _study(session)
    session.add(_document(study, uploaded_by_user_id=4242))
    with pytest.raises(IntegrityError):
        session.flush()


def test_documents_cascade_on_study_delete(session):
    study = _study(session)
    session.add(_document(study))
    session.flush()

    session.delete(study)
    session.flush()

    assert session.query(StudyDocument).filter_by(study_id=study.id).all() == []
