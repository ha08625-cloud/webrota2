"""Nurse rota router: the nurse-row view of the active master template,
plus administration of the nurses themselves.

A second permission area over the SAME tables the clinical routers edit.
The partition is `Doctor.doctor_type == NURSE` -- over `doctors` for the
staff endpoints and over `master_rota_sessions` for the rota ones, not a
separate table in either case. Three rules are what make that partition a
real boundary rather than a filter on the read:

1. Every write resolves the target doctor and 404s unless they are a
   nurse -- 404 rather than 403, because the session is not part of this
   resource and a 403 would confirm it exists.
2. Room displacement, which the master rota does silently, refuses with a
   409 naming the holder when that holder is not a nurse. Displacement is
   the exact mechanism by which a nurse_rota-only login could otherwise
   reach and mutate a doctor's row, so this is the permission boundary
   itself. Nurse-on-nurse displacement keeps the master rota's behaviour.
3. No write can set or change `doctor_type`. POST /nurse-rota/nurses sets
   NURSE itself rather than taking it from the payload, and `NursePatch`
   has no `doctor_type` field -- without that second half, rule 1 would be
   worth nothing, since a nurse could be promoted out of the partition one
   request later.

The reverse is deliberately NOT symmetrical: a clinical writer on the
Master Rota can still displace a nurse, and `/doctors` remains the
clinical administrator's full staff surface, nurses included -- demoting
an existing doctor *into* nurse-hood stays a `clinical: write` action
there. `clinical: write` is the superset.

The write paths carry no template_id -- the nurse surface only ever edits
the active template, so the router resolves it and 404s any session id
that is not in it. Without that check, dropping the path parameter would
let a nurse edit an archived template's rows by id.

Nurses are inert to the engine (engine/phases/_shared.INERT_TYPES), so
nothing here feeds generation beyond one fact: a room a nurse books is an
ordinary occupied room for that slot, and the generator will not hand it
to a doctor. That is correct, and it is visible to the rota administrator
on the Master Rota.
"""
from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from ...models import Doctor, MasterRotaSession, MasterRotaTemplate, Room, User
from ...models.enums import DoctorType, MasterSessionType
from ..deps import get_current_user, get_db
from ..schemas import (
    DoctorDeleteOut,
    DoctorOut,
    DoctorUsageOut,
    MasterRotaSessionOut,
    NurseIn,
    NursePatch,
    NurseRotaOut,
    NurseSessionCreateIn,
    NurseSessionPatchIn,
    NurseSessionWriteOut,
    NurseSlotOccupancy,
    RoomOut,
)
from ._doctors import (
    create_doctor_row,
    doctor_usage_counts,
    purge_doctor,
    validate_window,
)
from .master_rota import _find_room_holder, _session_outs

router = APIRouter(prefix="/nurse-rota", tags=["nurse_rota"])


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _active_template(db: Session) -> MasterRotaTemplate:
    """The active template, resolved exactly as master_rota does: lowest id
    among is_active rows, because is_active is not enforced unique (see
    MasterRotaTemplate's docstring) and a second active row must resolve
    deterministically rather than 500 the page."""
    template = db.execute(
        select(MasterRotaTemplate)
        .where(MasterRotaTemplate.is_active.is_(True))
        .order_by(MasterRotaTemplate.id)
    ).scalars().first()
    if template is None:
        raise HTTPException(status_code=404, detail="No active master rota template")
    return template


def _require_nurse(db: Session, doctor_id: int) -> Doctor:
    """The doctor, if they are a nurse. 404 otherwise -- for a non-nurse
    this resource does not contain them, and a 403 would say it does."""
    doctor = db.get(Doctor, doctor_id)
    if doctor is None or doctor.doctor_type != DoctorType.NURSE:
        raise HTTPException(
            status_code=404, detail=f"Nurse {doctor_id} not found"
        )
    return doctor


def _resolve_target(
    db: Session, session_id: int
) -> tuple[MasterRotaTemplate, MasterRotaSession]:
    """The active template and a session of it belonging to a nurse.

    404s in three places, all with the same shape: no active template, a
    session id that is not in the active template, and a session whose
    doctor is not a nurse."""
    template = _active_template(db)
    target = db.get(MasterRotaSession, session_id)
    if target is None or target.template_id != template.id:
        raise HTTPException(
            status_code=404, detail=f"Nurse rota session {session_id} not found"
        )
    _require_nurse(db, target.doctor_id)
    return template, target


def _displace_or_409(
    db: Session,
    template_id: int,
    week: int,
    day,
    period,
    room_id: int,
    exclude_id: int | None,
) -> MasterRotaSession | None:
    """Clear a nurse holder out of `room_id` in this slot, or refuse.

    The holder lookup is master_rota's own `_find_room_holder`, imported
    rather than copied: one copy of that predicate is the point, and the
    two routers write to the same table. Only the decision afterwards
    differs -- master displaces anybody, this refuses when the holder is
    not a nurse.
    """
    holder = _find_room_holder(
        db, template_id, week, day, period, room_id, exclude_id=exclude_id
    )
    if holder is None:
        return None

    holder_doctor = db.get(Doctor, holder.doctor_id)
    if holder_doctor is None or holder_doctor.doctor_type != DoctorType.NURSE:
        code = holder_doctor.code if holder_doctor is not None else "?"
        raise HTTPException(
            status_code=409,
            detail=(
                f"That room is taken by {code} in this session. Nurse rota "
                "edits cannot move a doctor out of a room."
            ),
        )

    holder.room_id = None
    if holder.session_type == MasterSessionType.PRE_ASSIGNED:
        holder.session_type = MasterSessionType.REQUIRES_ROOM
    return holder


def _require_room(db: Session, room_id: int) -> Room:
    room = db.get(Room, room_id)
    if room is None:
        raise HTTPException(status_code=404, detail=f"Room {room_id} not found")
    return room


def _write_out(
    db: Session,
    target: MasterRotaSession,
    displaced: MasterRotaSession | None,
) -> NurseSessionWriteOut:
    to_serialise = [target] if displaced is None else [target, displaced]
    outs: dict[int, MasterRotaSessionOut] = {
        s.session_id: s for s in _session_outs(db, to_serialise)
    }
    return NurseSessionWriteOut(
        session=outs[target.id],
        displaced_session=outs.get(displaced.id) if displaced is not None else None,
    )


# ---------------------------------------------------------------------------
# Endpoints
# ---------------------------------------------------------------------------

@router.get("/active", response_model=NurseRotaOut)
def get_active_nurse_rota(
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
) -> NurseRotaOut:
    """The active template's nurse rows, every room, and who else holds
    which room.

    Non-nurse sessions contribute nothing but occupancy: a room_id, the
    slot it is held in, and the holder's code. Rooms are ALL rooms, not
    just treatment rooms -- a nurse may be placed in any room.
    """
    template = _active_template(db)

    sessions = db.execute(
        select(MasterRotaSession).where(
            MasterRotaSession.template_id == template.id
        )
    ).scalars().all()
    doctors = {d.id: d for d in db.execute(select(Doctor)).scalars()}
    rooms = db.execute(select(Room).order_by(Room.code)).scalars().all()
    room_codes = {r.id: r.code for r in rooms}

    nurse_sessions: list[MasterRotaSession] = []
    occupancy: list[NurseSlotOccupancy] = []
    for s in sessions:
        doctor = doctors.get(s.doctor_id)
        if doctor is not None and doctor.doctor_type == DoctorType.NURSE:
            nurse_sessions.append(s)
        elif s.room_id is not None:
            occupancy.append(NurseSlotOccupancy(
                week=s.week,
                day=s.day,
                period=s.period,
                room_id=s.room_id,
                room_code=room_codes.get(s.room_id, "?"),
                doctor_code=doctor.code if doctor is not None else "?",
            ))

    return NurseRotaOut(
        template_id=template.id,
        name=template.name,
        sessions=_session_outs(db, nurse_sessions),
        rooms=[RoomOut.model_validate(r) for r in rooms],
        occupancy=occupancy,
    )


@router.patch("/sessions/{session_id}", response_model=NurseSessionWriteOut)
def patch_nurse_session(
    session_id: int,
    payload: NurseSessionPatchIn,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
) -> NurseSessionWriteOut:
    """Verbatim (session_type, room_id) pair setter on one nurse row."""
    template, target = _resolve_target(db, session_id)

    displaced: MasterRotaSession | None = None
    if payload.room_id is not None:
        _require_room(db, payload.room_id)
        displaced = _displace_or_409(
            db, template.id, target.week, target.day, target.period,
            payload.room_id, exclude_id=target.id,
        )

    target.session_type = payload.session_type
    target.room_id = payload.room_id

    db.flush()
    db.commit()
    return _write_out(db, target, displaced)


@router.post("/sessions", response_model=NurseSessionWriteOut, status_code=201)
def create_nurse_session(
    payload: NurseSessionCreateIn,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
) -> NurseSessionWriteOut:
    """Create a nurse slot in the active template.

    Same displacement rule as PATCH, run before insert since there is no
    self row to exclude yet. No active-doctor check -- the server stays a
    permissive verbatim writer, as the master rota is, which is also what
    keeps undo-recreate working if a nurse is deactivated mid-session.
    """
    template = _active_template(db)
    _require_nurse(db, payload.doctor_id)

    existing = db.execute(
        select(MasterRotaSession).where(
            MasterRotaSession.template_id == template.id,
            MasterRotaSession.doctor_id == payload.doctor_id,
            MasterRotaSession.week == payload.week,
            MasterRotaSession.day == payload.day,
            MasterRotaSession.period == payload.period,
        )
    ).scalars().first()
    if existing is not None:
        raise HTTPException(
            status_code=409,
            detail=(
                f"Nurse {payload.doctor_id} already has a session at week "
                f"{payload.week} {payload.day.value} {payload.period.value}"
            ),
        )

    displaced: MasterRotaSession | None = None
    if payload.room_id is not None:
        _require_room(db, payload.room_id)
        displaced = _displace_or_409(
            db, template.id, payload.week, payload.day, payload.period,
            payload.room_id, exclude_id=None,
        )

    target = MasterRotaSession(
        template_id=template.id,
        doctor_id=payload.doctor_id,
        week=payload.week,
        day=payload.day,
        period=payload.period,
        session_type=payload.session_type,
        room_id=payload.room_id,
    )
    db.add(target)

    db.flush()
    db.commit()
    return _write_out(db, target, displaced)


@router.delete("/sessions/{session_id}", status_code=204)
def delete_nurse_session(
    session_id: int,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
) -> None:
    """Delete a nurse slot from the active template.

    Hard delete, as the master rota's is: MasterRotaSession has no
    children and the template has no draft/committed lifecycle. No
    response body -- the frontend captures undo data from the in-memory
    session before issuing the request.
    """
    _template, target = _resolve_target(db, session_id)
    db.delete(target)
    db.commit()


# ---------------------------------------------------------------------------
# Nurse staff
# ---------------------------------------------------------------------------

@router.get("/nurses", response_model=list[DoctorOut])
def list_nurses(
    include_inactive: bool = False,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
) -> list[Doctor]:
    """Every nurse, by code.

    The section's own list rather than `GET /doctors` filtered client-side:
    that route is one of the two deliberate holes in default-deny
    (`deps._SHARED_READ`), open for the user-admin linked-doctor picker
    rather than for this page, and a create here has to invalidate a key
    the rota grid reads.

    `include_inactive` matches `GET /reception/staff`'s flag for the same
    reason: this is the section's only management surface, so a
    deactivation needs a visible way back.
    """
    stmt = (
        select(Doctor)
        .where(Doctor.doctor_type == DoctorType.NURSE)
        .order_by(Doctor.code)
    )
    if not include_inactive:
        stmt = stmt.where(Doctor.active.is_(True))
    return db.execute(stmt).scalars().all()


@router.post("/nurses", response_model=DoctorOut, status_code=201)
def create_nurse(
    payload: NurseIn,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
) -> Doctor:
    """Create a nurse. `doctor_type` is set here, never taken from the body.

    The row mechanics -- the SystemCounter and calendar-token invariants --
    are `_doctors.create_doctor_row`, shared with `/doctors` so there is one
    definition of what a doctor row must have at birth.
    """
    validate_window(payload.start_date, payload.end_date)
    try:
        nurse = create_doctor_row(
            db,
            code=payload.code,
            doctor_type=DoctorType.NURSE,
            start_date=payload.start_date,
            end_date=payload.end_date,
        )
        db.commit()
    except IntegrityError as exc:
        db.rollback()
        raise HTTPException(
            status_code=409,
            detail=f"Staff code '{payload.code}' is already in use",
        ) from exc
    db.refresh(nurse)
    return nurse


@router.get("/nurses/{doctor_id}", response_model=DoctorOut)
def get_nurse(
    doctor_id: int,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
) -> Doctor:
    return _require_nurse(db, doctor_id)


@router.patch("/nurses/{doctor_id}", response_model=DoctorOut)
def patch_nurse(
    doctor_id: int,
    payload: NursePatch,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
) -> Doctor:
    """Edit a nurse's code, active flag or employment window.

    `doctor_type` is not in `NursePatch`, so it cannot be changed here --
    see rule 3 in the module docstring. Deactivation is this endpoint with
    `{"active": false}`; DELETE means delete.
    """
    nurse = _require_nurse(db, doctor_id)
    updates = payload.model_dump(exclude_unset=True)
    # Validate the window against the *merged* values, exactly as
    # patch_doctor does: a PATCH setting only start_date still has to sit
    # before whatever end_date the row already holds.
    validate_window(
        updates.get("start_date", nurse.start_date),
        updates.get("end_date", nurse.end_date),
    )
    for field, value in updates.items():
        setattr(nurse, field, value)
    try:
        db.commit()
    except IntegrityError as exc:
        db.rollback()
        raise HTTPException(
            status_code=409, detail="That staff code is already in use"
        ) from exc
    db.refresh(nurse)
    return nurse


@router.get("/nurses/{doctor_id}/usage", response_model=DoctorUsageOut)
def nurse_usage(
    doctor_id: int,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
) -> DoctorUsageOut:
    """What deleting this nurse would destroy -- the delete dialog's input.

    `DoctorUsageOut` reused verbatim rather than a trimmed nurse variant:
    it is eight plain integers with no `code` and no `doctor_type`, so it
    widens the nurse surface by nothing, and the obvious trim would be
    wrong. See `_doctors.doctor_usage_counts` for why the four counts that
    look structurally zero for a nurse are reported anyway.
    """
    return doctor_usage_counts(db, _require_nurse(db, doctor_id))


@router.delete("/nurses/{doctor_id}", response_model=DoctorDeleteOut)
def delete_nurse(
    doctor_id: int,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
) -> DoctorDeleteOut:
    """Permanently remove a nurse and every row that references them.

    **No `user_admin` dependency, deliberately** -- and this is the first
    permanent staff purge in the API without one. `DELETE /doctors/{id}`
    and `DELETE /reception/staff/{id}` both carry it on top of their area
    gate; keeping it here would mean a nurse_rota-only login could never
    delete, which is the feature.

    State the cost accurately: the login this widens is not only the
    nurse-only one but `rota_admin`, which holds `clinical: write` +
    `nurse_rota: write` + `user_admin: false`. Today it can permanently
    purge nobody; after this it can purge any nurse through this endpoint
    while still being refused on `DELETE /doctors/{id}` for the same row.
    And the purge is genuinely destructive for a nurse: Phase 2 builds grid
    slots for nurse rows like anyone else's, so a nurse accumulates
    `rota_sessions` in committed rotas, and nothing rejects a nurse from
    /leave, /duty or /extra-sessions either.

    The three mitigations are the ones `/doctors` already relies on and
    they all stay: the 409 below (deactivate first -- a deliberate two-step
    which, unlike a has-history guard, never makes a nurse who has actually
    worked permanently undeletable), `GET /nurse-rota/nurses/{id}/usage`
    feeding the confirm dialog, and the audit log, which records who
    deleted which id after the rows are gone.
    """
    nurse = _require_nurse(db, doctor_id)
    if nurse.active:
        raise HTTPException(
            status_code=409,
            detail=f"Nurse '{nurse.code}' is active -- deactivate before deleting",
        )

    counts = purge_doctor(db, nurse)
    db.commit()

    return DoctorDeleteOut(deleted=counts)
