"""RecurringNote router -- the definition library.

These endpoints schedule nothing. A definition is a named meeting with
default day/period/doctors; picking it on the staging page copies those
onto a per-run instance (routers/staging.py), and the copy is never
re-read from here afterwards.

Writes accept the full nested object (parent + doctor_ids) in one
payload, mirroring clinic_types.py's replace-children pattern: PUT
deletes all existing child rows and inserts the new set, rather than
diffing. Children are cleared and flushed before the replacement set is
attached, for the same reason clinic_types.py does it -- SQLAlchemy does
not guarantee the DELETEs for a delete-orphan collection are flushed before
the INSERTs for a reassigned one on the same table, so an edit that keeps
even one doctor unchanged could otherwise trip the unique constraint
(note_id, doctor_id) spuriously.

There is no IntegrityError guard here, unlike clinic_types.py: doctor_ids
is deduplicated by RecurringNoteIn's validator before this ever runs,
doctors are soft-deleted only (see models/recurring_note.py), and there is
no cross-note uniqueness rule at all (overlapping notes are legal and
concatenate at generation time). The only write-time rejection is the
shared doctor existence/active check, which is a DB-backed 422, not a
constraint violation.

Delete nulls `source_note_id` on any instance already picked from this
definition rather than cascading: the instance is a snapshot that stands
on its own, and the FK would otherwise block the delete outright.
"""
from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select, update
from sqlalchemy.orm import Session, selectinload

from ...engine.week_map import DAY_ORDER
from ...models import (
    RecurringNote,
    RecurringNoteDoctor,
    RotaConfigNote,
    User,
)
from ..deps import get_current_user, get_db
from ..schemas import RecurringNoteIn, RecurringNoteOut
from ._doctor_ids import validate_doctor_ids

router = APIRouter(prefix="/recurring-notes", tags=["recurring_notes"])


def _get_or_404(db: Session, note_id: int) -> RecurringNote:
    note = db.get(RecurringNote, note_id)
    if note is None:
        raise HTTPException(
            status_code=404, detail=f"RecurringNote {note_id} not found"
        )
    return note


def _apply(db: Session, note: RecurringNote, payload: RecurringNoteIn) -> None:
    note.text = payload.text
    note.day = payload.day
    note.period = payload.period
    note.is_active = payload.is_active

    # See module docstring: clear and flush before attaching the
    # replacement set, or a doctor unchanged by the edit can trip the
    # unique constraint via an INSERT racing an unflushed DELETE.
    note.doctors.clear()
    db.flush()

    note.doctors = [RecurringNoteDoctor(doctor_id=d) for d in payload.doctor_ids]


@router.get("", response_model=list[RecurringNoteOut])
def list_recurring_notes(
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
) -> list[RecurringNoteOut]:
    notes = db.execute(
        select(RecurringNote).options(selectinload(RecurringNote.doctors))
    ).scalars().all()
    # Ordered in Python, not SQL: Day/Period are stored by value, so
    # ORDER BY day gives alphabetical ("Friday" first), not weekday order.
    notes = sorted(notes, key=lambda n: (DAY_ORDER[n.day], n.period, n.id))
    return [RecurringNoteOut.from_orm_note(n) for n in notes]


@router.post("", response_model=RecurringNoteOut, status_code=201)
def create_recurring_note(
    payload: RecurringNoteIn,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
) -> RecurringNoteOut:
    validate_doctor_ids(db, payload.doctor_ids)
    note = RecurringNote()
    db.add(note)
    _apply(db, note, payload)
    db.commit()
    db.refresh(note)
    return RecurringNoteOut.from_orm_note(note)


@router.put("/{note_id}", response_model=RecurringNoteOut)
def replace_recurring_note(
    note_id: int,
    payload: RecurringNoteIn,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
) -> RecurringNoteOut:
    note = _get_or_404(db, note_id)
    validate_doctor_ids(db, payload.doctor_ids)
    _apply(db, note, payload)
    db.commit()
    db.refresh(note)
    return RecurringNoteOut.from_orm_note(note)


@router.delete("/{note_id}", status_code=204)
def delete_recurring_note(
    note_id: int,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
) -> None:
    note = _get_or_404(db, note_id)
    # Instances picked from this definition are snapshots and survive it;
    # only their provenance pointer goes. Without this the FK blocks the
    # delete.
    db.execute(
        update(RotaConfigNote)
        .where(RotaConfigNote.source_note_id == note_id)
        .values(source_note_id=None)
    )
    db.delete(note)  # ORM cascade removes the doctor rows
    db.commit()