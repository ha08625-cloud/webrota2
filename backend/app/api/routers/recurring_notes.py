"""RecurringNote router.

Writes accept the full nested object (parent + doctor_ids + template_weeks)
in one payload, mirroring clinic_types.py's replace-children pattern:
PUT deletes all existing child rows and inserts the new set, rather than
diffing. Children are cleared and flushed before the replacement set is
attached, for the same reason clinic_types.py does it -- SQLAlchemy does
not guarantee the DELETEs for a delete-orphan collection are flushed before
the INSERTs for a reassigned one on the same table, so an edit that keeps
even one doctor or week unchanged could otherwise trip the unique
constraint (note_id, doctor_id) / (note_id, template_week) spuriously.

There is no IntegrityError guard here, unlike clinic_types.py: doctor_ids
and template_weeks are deduplicated by RecurringNoteIn's validators before
this ever runs, doctors are soft-deleted only (see models/recurring_note.py),
and there is no cross-note uniqueness rule at all (
overlapping notes are legal and concatenate at generation time). The only
write-time rejection is the doctor existence/active check below, which is a
DB-backed 422, not a constraint violation.
"""
from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.orm import Session, selectinload

from ...engine.week_map import DAY_ORDER
from ...models import (
    Doctor,
    RecurringNote,
    RecurringNoteDoctor,
    RecurringNoteWeek,
    User,
)
from ..deps import get_current_user, get_db
from ..schemas import RecurringNoteIn, RecurringNoteOut

router = APIRouter(prefix="/recurring-notes", tags=["recurring_notes"])


def _get_or_404(db: Session, note_id: int) -> RecurringNote:
    note = db.get(RecurringNote, note_id)
    if note is None:
        raise HTTPException(
            status_code=404, detail=f"RecurringNote {note_id} not found"
        )
    return note


def _validate_doctor_ids(db: Session, doctor_ids: list[int]) -> None:
    """Every id must exist and be active, else 422 naming the offending
    ids. A DB-backed check in the router, not a Pydantic validator, for the
    same reason duty.py's closed-date check is one -- a stateless validator
    cannot see the doctors table."""
    rows = db.execute(
        select(Doctor.id, Doctor.active).where(Doctor.id.in_(doctor_ids))
    ).all()
    found = {row.id: row.active for row in rows}
    missing = sorted(set(doctor_ids) - found.keys())
    inactive = sorted(i for i in doctor_ids if i in found and not found[i])
    if missing or inactive:
        parts = []
        if missing:
            parts.append(f"doctor id(s) {missing} do not exist")
        if inactive:
            parts.append(f"doctor id(s) {inactive} are not active")
        raise HTTPException(status_code=422, detail="; ".join(parts))


def _apply(db: Session, note: RecurringNote, payload: RecurringNoteIn) -> None:
    note.text = payload.text
    note.day = payload.day
    note.period = payload.period
    note.is_active = payload.is_active

    # See module docstring: clear and flush before attaching the
    # replacement set, or a doctor/week unchanged by the edit can trip the
    # unique constraint via an INSERT racing an unflushed DELETE.
    note.doctors.clear()
    note.weeks.clear()
    db.flush()

    note.doctors = [RecurringNoteDoctor(doctor_id=d) for d in payload.doctor_ids]
    note.weeks = [RecurringNoteWeek(template_week=w) for w in payload.template_weeks]


@router.get("", response_model=list[RecurringNoteOut])
def list_recurring_notes(
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
) -> list[RecurringNoteOut]:
    notes = db.execute(
        select(RecurringNote).options(
            selectinload(RecurringNote.doctors), selectinload(RecurringNote.weeks)
        )
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
    _validate_doctor_ids(db, payload.doctor_ids)
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
    _validate_doctor_ids(db, payload.doctor_ids)
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
    db.delete(note)  # ORM cascade removes both child tables' rows
    db.commit()