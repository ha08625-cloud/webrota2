"""ClinicType router.

Writes accept the full nested object (parent + schedules +
doctor_eligibilities + room_eligibilities) in one transaction, per the M3
plan. PUT uses the replace-children pattern: all existing child rows are
deleted and the new set inserted -- simpler than diffing, and safe for
counter history because ClinicCounter is keyed on values, never on child-row
FKs (M1 design decision).

Children are cleared and flushed before the replacement set is attached
(see `_apply`) -- SQLAlchemy does not guarantee that the DELETEs for
delete-orphan children are flushed before the INSERTs for a reassigned
collection on the same table, so an edit that keeps even one schedule slot,
doctor, or room unchanged can otherwise trigger a spurious unique-constraint
IntegrityError.

clinic_priority is server-managed, not client-settable: ClinicTypeIn has no
such field, so a stale client that still sends one is silently ignored by
Pydantic's default extra-field handling. The database enforces a contiguous
1..N sequence over enabled rows only via a partial unique index (migration
005). Three helpers maintain that invariant: `_next_priority` (append at the
end, used on create and on a disabled-to-enabled transition), `_close_gap`
(used on delete of an enabled row and on an enabled-to-disabled transition),
and the dedicated `PUT /clinic-types/reorder` endpoint (the only genuine
arbitrary permutation, using a two-phase negative-placeholder update).
"""
from __future__ import annotations

from contextlib import contextmanager

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import func, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from ...models import (
    ClinicType,
    ClinicTypeDoctorEligibility,
    ClinicTypeRoomEligibility,
    ClinicTypeSchedule,
)
from ..deps import get_current_user, get_db
from ..schemas import ClinicTypeIn, ClinicTypeOut, ClinicTypePatch, ClinicTypeReorderIn

router = APIRouter(prefix="/clinic-types", tags=["clinic_types"])


def _get_or_404(db: Session, clinic_type_id: int) -> ClinicType:
    ct = db.get(ClinicType, clinic_type_id)
    if ct is None:
        raise HTTPException(
            status_code=404, detail=f"ClinicType {clinic_type_id} not found"
        )
    return ct


def _next_priority(db: Session) -> int:
    """max(enabled priorities) + 1, or 1 if none are enabled.

    max+1 rather than count+1: tolerant of a gap ever existing (there
    shouldn't be one under the invariants this router maintains, but max+1
    costs nothing extra, whereas count+1 would collide with an existing
    priority and 409 every subsequent create if a gap ever appeared).
    """
    max_priority = db.execute(
        select(func.max(ClinicType.clinic_priority)).where(
            ClinicType.is_enabled.is_(True)
        )
    ).scalar_one()
    return (max_priority or 0) + 1


def _close_gap(db: Session, vacated_priority: int) -> None:
    """Shift every enabled row with priority > vacated_priority down by 1.

    Per-row updates in ascending priority order, flushing between rows --
    NOT a single bulk UPDATE. Postgres checks a non-deferrable unique index
    per row in whatever order it visits them, so a bulk decrement can
    spuriously collide with itself; ascending per-row updates always move a
    row into a value just vacated by the previous update, so no placeholder
    is needed.
    """
    rows = db.execute(
        select(ClinicType)
        .where(
            ClinicType.is_enabled.is_(True),
            ClinicType.clinic_priority > vacated_priority,
        )
        .order_by(ClinicType.clinic_priority)
    ).scalars().all()
    for row in rows:
        row.clinic_priority -= 1
        db.flush()


def _children_from_payload(payload: ClinicTypeIn) -> tuple[list, list, list]:
    schedules = [
        ClinicTypeSchedule(day=s.day, period=s.period) for s in payload.schedules
    ]
    doctor_eligs = [
        ClinicTypeDoctorEligibility(
            doctor_id=e.doctor_id, doctor_priority=e.doctor_priority
        )
        for e in payload.doctor_eligibilities
    ]
    room_eligs = [
        ClinicTypeRoomEligibility(room_id=e.room_id, room_type=e.room_type)
        for e in payload.room_eligibilities
    ]
    return schedules, doctor_eligs, room_eligs


def _apply(db: Session, ct: ClinicType, payload: ClinicTypeIn) -> None:
    ct.name = payload.name
    ct.is_enabled = payload.is_enabled
    ct.room_required = payload.room_required
    ct.category = payload.category

    # Clear the existing children and flush the deletes before attaching the
    # replacement set. Assigning a brand-new list directly to the relationship
    # still works via the delete-orphan cascade, but the DELETEs and INSERTs
    # for the old and new rows are not guaranteed to be ordered DELETE-first
    # within the same flush -- if a new row shares a unique key (day/period,
    # doctor_id, or room_id/room_type) with a row being replaced, the INSERT
    # can be attempted while the old row is still present, raising a
    # spurious IntegrityError even though the end state would be valid.
    ct.schedules.clear()
    ct.doctor_eligibilities.clear()
    ct.room_eligibilities.clear()
    db.flush()

    schedules, doctor_eligs, room_eligs = _children_from_payload(payload)
    ct.schedules = schedules
    ct.doctor_eligibilities = doctor_eligs
    ct.room_eligibilities = room_eligs


@contextmanager
def _integrity_guard(db: Session, detail: str):
    """Wrap a write endpoint's whole apply-through-commit sequence.

    _apply() flushes internally to sequence child-row deletes before
    inserts (see its docstring), and the priority helpers flush per row.
    A plain UNIQUE constraint is checked by SQLite and Postgres at
    statement-execution time -- i.e. whichever flush happens to send that
    particular INSERT/UPDATE, not necessarily the final commit(). A create
    with a duplicate name, for example, is inserted by _apply()'s internal
    flush, not by commit(). Catching IntegrityError only around commit()
    therefore misses violations surfaced by an earlier flush, letting them
    escape as an unhandled 500 instead of a 409. This guard wraps the
    entire sequence so it doesn't matter which flush trips the constraint.
    """
    try:
        yield
        db.commit()
    except IntegrityError as exc:
        db.rollback()
        raise HTTPException(status_code=409, detail=detail) from exc


@router.get("", response_model=list[ClinicTypeOut])
def list_clinic_types(
    db: Session = Depends(get_db),
    user: dict = Depends(get_current_user),
) -> list[ClinicType]:
    return db.execute(
        select(ClinicType).order_by(ClinicType.clinic_priority, ClinicType.name)
    ).scalars().all()


@router.post("", response_model=ClinicTypeOut, status_code=201)
def create_clinic_type(
    payload: ClinicTypeIn,
    db: Session = Depends(get_db),
    user: dict = Depends(get_current_user),
) -> ClinicType:
    ct = ClinicType()
    detail = (
        f"ClinicType '{payload.name}' violates a uniqueness constraint "
        "(duplicate name, schedule slot, doctor, or room eligibility)"
    )
    with _integrity_guard(db, detail):
        # Assign before _apply()/add() so the NOT NULL column is always
        # satisfied and the append value is computed against existing rows
        # only, never against this not-yet-flushed one. A disabled create
        # also gets an appended value -- harmless, since disabled rows sit
        # outside the partial unique index, and it means the value is
        # already sane the moment the row is enabled.
        ct.clinic_priority = _next_priority(db)
        db.add(ct)
        _apply(db, ct, payload)
    db.refresh(ct)
    return ct


@router.get("/{clinic_type_id}", response_model=ClinicTypeOut)
def get_clinic_type(
    clinic_type_id: int,
    db: Session = Depends(get_db),
    user: dict = Depends(get_current_user),
) -> ClinicType:
    return _get_or_404(db, clinic_type_id)


@router.put("/reorder", response_model=list[ClinicTypeOut])
def reorder_clinic_types(
    payload: ClinicTypeReorderIn,
    db: Session = Depends(get_db),
    user: dict = Depends(get_current_user),
) -> list[ClinicType]:
    # Registered before PUT /{clinic_type_id}: if that route were declared
    # first, "reorder" would be attempted as the int path parameter and
    # fail validation with a 422 instead of ever reaching this handler.
    ordered_ids = payload.ordered_ids

    if len(ordered_ids) != len(set(ordered_ids)):
        raise HTTPException(
            status_code=409, detail="ordered_ids contains a duplicate id"
        )

    current_enabled_ids = set(
        db.execute(
            select(ClinicType.id).where(ClinicType.is_enabled.is_(True))
        ).scalars().all()
    )
    if set(ordered_ids) != current_enabled_ids:
        raise HTTPException(
            status_code=409,
            detail=(
                "ordered_ids must contain exactly the current set of "
                "enabled clinic type ids, no more and no fewer"
            ),
        )

    rows_by_id = {
        row.id: row
        for row in db.execute(
            select(ClinicType).where(ClinicType.id.in_(ordered_ids))
        ).scalars().all()
    }

    # Two-phase negative-placeholder update: a drag-and-drop reorder is a
    # genuine arbitrary permutation, so one row's target can already be
    # another row's current value. Phase 1 parks every affected row at
    # -(new_priority) -- distinct negatives that can never collide with
    # each other or with any current positive value. A flush makes that
    # fully-negative state visible to the index before phase 2 writes any
    # positive value. Phase 2 then flips every row's sign onto its real,
    # again-distinct target.
    with _integrity_guard(db, "reorder failed a uniqueness check"):
        for position, clinic_type_id in enumerate(ordered_ids, start=1):
            rows_by_id[clinic_type_id].clinic_priority = -position
        db.flush()

        for row in rows_by_id.values():
            row.clinic_priority = -row.clinic_priority

    for row in rows_by_id.values():
        db.refresh(row)
    return [rows_by_id[cid] for cid in ordered_ids]


@router.put("/{clinic_type_id}", response_model=ClinicTypeOut)
def replace_clinic_type(
    clinic_type_id: int,
    payload: ClinicTypeIn,
    db: Session = Depends(get_db),
    user: dict = Depends(get_current_user),
) -> ClinicType:
    ct = _get_or_404(db, clinic_type_id)
    # Captured before _apply() overwrites is_enabled.
    was_enabled = ct.is_enabled
    old_priority = ct.clinic_priority
    now_enabled = payload.is_enabled

    detail = (
        f"ClinicType '{payload.name}' violates a uniqueness constraint "
        "(duplicate name, schedule slot, doctor, or room eligibility)"
    )
    with _integrity_guard(db, detail):
        if not was_enabled and now_enabled:
            # Disabled -> enabled: assign the appended value now, before
            # _apply() flips is_enabled to True and flushes. _apply()'s
            # internal flush would otherwise briefly persist an enabled row
            # still holding its old, stale (possibly colliding) priority,
            # tripping the partial unique index before we get a chance to
            # reassign it.
            ct.clinic_priority = _next_priority(db)

        _apply(db, ct, payload)

        if was_enabled and not now_enabled:
            # Enabled -> disabled: _apply()'s internal flush has already
            # persisted is_enabled=False, so this row is already outside
            # the index's scope -- safe to gap-close the rows above it.
            db.flush()
            _close_gap(db, old_priority)

        # enabled -> enabled or disabled -> disabled: priority untouched.

    db.refresh(ct)
    return ct


@router.patch("/{clinic_type_id}", response_model=ClinicTypeOut)
def patch_clinic_type(
    clinic_type_id: int,
    payload: ClinicTypePatch,
    db: Session = Depends(get_db),
    user: dict = Depends(get_current_user),
) -> ClinicType:
    """Partial update for is_enabled / room_required only.

    name/category stay PUT-only; this endpoint exists so the frontend can
    toggle the two booleans inline without round-tripping the full nested
    payload (schedules/eligibilities are never touched here).
    """
    ct = _get_or_404(db, clinic_type_id)
    updates = payload.model_dump(exclude_unset=True)
    if not updates:
        return ct  # empty body: valid no-op

    # exclude_unset alone isn't enough -- PATCH {"is_enabled": true} on an
    # already-enabled row must not touch priority, or a row that never left
    # the partial unique index gets needlessly renumbered.
    enabling = "is_enabled" in updates and updates["is_enabled"] and not ct.is_enabled
    disabling = "is_enabled" in updates and not updates["is_enabled"] and ct.is_enabled
    old_priority = ct.clinic_priority

    detail = f"ClinicType {clinic_type_id} patch violates a uniqueness constraint"
    with _integrity_guard(db, detail):
        if enabling:
            # Assign the appended value before flipping is_enabled -- see
            # replace_clinic_type's disabled->enabled comment. _next_priority's
            # SELECT autoflushes pending changes, so setting is_enabled=True
            # first would briefly persist an enabled row with a stale,
            # possibly colliding priority.
            ct.clinic_priority = _next_priority(db)

        for field, value in updates.items():
            setattr(ct, field, value)

        if disabling:
            # Enabled -> disabled: flush so this row is outside the
            # index's scope before gap-closing the rows above it.
            db.flush()
            _close_gap(db, old_priority)

        # No transition (same-value send, or room_required-only patch):
        # priority untouched.

    db.refresh(ct)
    return ct


@router.delete("/{clinic_type_id}", status_code=204)
def delete_clinic_type(
    clinic_type_id: int,
    db: Session = Depends(get_db),
    user: dict = Depends(get_current_user),
) -> None:
    ct = _get_or_404(db, clinic_type_id)
    was_enabled = ct.is_enabled
    priority = ct.clinic_priority
    detail = (
        f"ClinicType {clinic_type_id} is referenced by counter or rota "
        "rows and cannot be deleted"
    )
    with _integrity_guard(db, detail):
        db.delete(ct)  # ORM cascade removes all child rows
        db.flush()
        if was_enabled:
            _close_gap(db, priority)