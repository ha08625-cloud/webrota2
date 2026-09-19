"""Doctor router.

**DELETE means delete.** Deactivation is `PATCH {"active": false}`, and the
two are not the same call. This used to be a soft delete that 409'd against
committed rotas; a deactivated doctor kept every row they had, which is why
they went on appearing on the master rota grid flagged "(inactive)" long
after someone thought they had removed them. Deleting now purges the doctor
row and every row that references it, matching routers/reception/staff.py --
the two staff deletes are now the same shape deliberately.

The delete purges history; it does not refuse to run. Removing a doctor
deletes their sessions from already-committed rotas, so a rota printed and
handed out months ago will no longer match what the app shows, their leave
and duty history is gone, and their counters disappear (which changes what
the next generation fairness-balances against). There is no way around
this: `rota_sessions.doctor_id` is non-nullable, and an orphan session with
no doctor attached is worse than no session. Blocking deletion for anyone
with committed rows -- what the old 409 did -- was rejected because it makes
anyone who has actually worked undeletable, which is exactly the
leaver case this exists for. The mitigations are informed consent in the UI
(`GET /doctors/{id}/usage` feeds the confirm dialog) and the audit log,
which records who deleted which doctor id even though the rows are gone.

Two guards stand in front of it, both mirroring reception staff:

- **`user_admin` as well.** This router is gated on `clinical` at
  include_router time; the delete additionally carries
  `require_capability("user_admin")`, so the effective rule is the
  conjunction clinical:write AND user_admin. An irreversible,
  history-destroying action should be the narrower permission rather than
  open to every rota editor. Deactivating stays open to them.
- **409 unless the doctor is already inactive.** Deleting is a deliberate
  two-step: deactivate, then later delete. It removes the "deleted someone
  who is on this week's rota" case entirely, and unlike a has-history guard
  it never makes anyone permanently undeletable.

The mechanics of creating and purging a doctor row -- the counter and
calendar-token invariants, PURGED_MODELS and NULLED_TABLES -- live in
routers/_doctors.py, shared with the nurse staff router. This module
owns the policy above; that one owns how it is carried out.

Treatment rooms are not selectable as preferred rooms: TR1-TR3 and CK are
nurse rooms no generation phase allocates, and a preferred room is the one
route by which a phase could still seat a doctor in one. The `room_type`
half of that rule is enforced by `PreferredRoomIn` in the schema module; the
`room_id` half needs the database to resolve an id to a room type, so it
lives here in `_reject_tr_rooms`. `PUT /doctors/{id}/preferred-rooms` is the
only write path -- neither DoctorIn nor DoctorPatch carries preferred-room
fields.

Token management (read the feed URL, rotate the token) lives here rather
than on the public calendar router, so it sits behind the ordinary session
gate. Rotation additionally carries `require_capability("user_admin")` on
top of that -- see its docstring.
"""
from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import delete, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from ...models import (
    Doctor,
    DoctorPreferredRoom,
    Room,
    User,
)
from ...models.enums import RoomType
from ..auth_utils import new_session_token
from ..deps import get_current_user, get_db, require_capability
from ..schemas import (
    CalendarFeedOut,
    DoctorDeleteOut,
    DoctorDetailOut,
    DoctorIn,
    DoctorOut,
    DoctorPatch,
    DoctorUsageOut,
    PreferredRoomIn,
)
from ._doctors import (
    create_doctor_row,
    doctor_usage_counts,
    purge_doctor,
    validate_window,
)
from .calendar import feed_path

router = APIRouter(prefix="/doctors", tags=["doctors"])


def _get_or_404(db: Session, doctor_id: int) -> Doctor:
    doctor = db.get(Doctor, doctor_id)
    if doctor is None:
        raise HTTPException(status_code=404, detail=f"Doctor {doctor_id} not found")
    return doctor


@router.get("", response_model=list[DoctorOut])
def list_doctors(
    active_only: bool = True,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
) -> list[Doctor]:
    stmt = select(Doctor).order_by(Doctor.code)
    if active_only:
        stmt = stmt.where(Doctor.active.is_(True))
    return db.execute(stmt).scalars().all()


@router.post("", response_model=DoctorOut, status_code=201)
def create_doctor(
    payload: DoctorIn,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
) -> Doctor:
    validate_window(payload.start_date, payload.end_date)
    try:
        doctor = create_doctor_row(
            db,
            code=payload.code,
            doctor_type=payload.doctor_type,
            start_date=payload.start_date,
            end_date=payload.end_date,
            sessions_per_week=payload.sessions_per_week,
            supervision_preference=payload.supervision_preference,
            wfh_preference=payload.wfh_preference,
        )
        db.commit()
    except IntegrityError as exc:
        db.rollback()
        raise HTTPException(
            status_code=409, detail=f"Doctor code '{payload.code}' already exists"
        ) from exc
    db.refresh(doctor)
    return doctor


@router.get("/{doctor_id}", response_model=DoctorDetailOut)
def get_doctor(
    doctor_id: int,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
) -> Doctor:
    return _get_or_404(db, doctor_id)


@router.patch("/{doctor_id}", response_model=DoctorOut)
def patch_doctor(
    doctor_id: int,
    payload: DoctorPatch,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
) -> Doctor:
    doctor = _get_or_404(db, doctor_id)
    updates = payload.model_dump(exclude_unset=True)
    # Validate the window against the *merged* values: a PATCH setting only
    # start_date still has to sit before whatever end_date the row already
    # holds.
    validate_window(
        updates.get("start_date", doctor.start_date),
        updates.get("end_date", doctor.end_date),
    )
    for field, value in updates.items():
        setattr(doctor, field, value)
    try:
        db.commit()
    except IntegrityError as exc:
        db.rollback()
        raise HTTPException(
            status_code=409, detail="Doctor code already exists"
        ) from exc
    db.refresh(doctor)
    return doctor


def _reject_tr_rooms(db: Session, payload: list[PreferredRoomIn]) -> None:
    """Treatment rooms (TR1-TR3, CK) cannot be a stored preference.

    `Doctor.preferred_rooms` is the one path by which a generation phase
    could seat a doctor in a room the engine is not supposed to allocate:
    Pass 3 of phase7_9a walks the preference list with no room-type filter,
    and phase5/room_relocation filter out D only. Every other room lookup in
    the engine names a single room type explicitly, so TR is unreachable.

    The room_type half of this rule lives in `PreferredRoomIn`; this half
    needs the DB to resolve room_id -> room_type. 400 with a string
    `detail`, matching `clinic_types._reject_unselectable_rooms`.

    Not enforced in the engine: `load_context()` keeps expanding whatever is
    stored, and Phase 0 warns about a row that predates this check or was
    written straight against the database.
    """
    room_ids = [p.room_id for p in payload if p.room_id is not None]
    if not room_ids:
        return
    codes = db.execute(
        select(Room.code)
        .where(Room.id.in_(room_ids), Room.room_type == RoomType.TR)
        .order_by(Room.code)
    ).scalars().all()
    if codes:
        noun = "Room" if len(codes) == 1 else "Rooms"
        verb = "is a treatment room" if len(codes) == 1 else "are treatment rooms"
        raise HTTPException(
            status_code=400,
            detail=(
                f"{noun} {', '.join(codes)} {verb} and cannot be a "
                f"preferred room"
            ),
        )


@router.put("/{doctor_id}/preferred-rooms", response_model=DoctorDetailOut)
def replace_preferred_rooms(
    doctor_id: int,
    payload: list[PreferredRoomIn],
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
) -> Doctor:
    doctor = _get_or_404(db, doctor_id)
    _reject_tr_rooms(db, payload)
    # Replace-all pattern, but as two explicit statements rather than an
    # ORM collection reassignment. Assigning doctor.preferred_rooms = [...]
    # leaves the flush free to emit the INSERTs for the new rows before the
    # DELETEs for the old ones (nothing FK-links them), and the new rows
    # reuse the same (doctor_id, preference_order) values the old ones
    # still hold - tripping uq_dpr_doctor_order on essentially every edit.
    # Deleting first and flushing before inserting removes the race.
    db.execute(delete(DoctorPreferredRoom).where(DoctorPreferredRoom.doctor_id == doctor_id))
    db.flush()
    for p in payload:
        db.add(
            DoctorPreferredRoom(
                doctor_id=doctor_id,
                preference_order=p.preference_order,
                room_id=p.room_id,
                room_type=p.room_type,
            )
        )
    try:
        db.commit()
    except IntegrityError as exc:
        db.rollback()
        raise HTTPException(
            status_code=409,
            detail="Duplicate preference_order or invalid room reference",
        ) from exc
    db.refresh(doctor)
    return doctor


def _feed_out(doctor: Doctor) -> CalendarFeedOut:
    return CalendarFeedOut(
        doctor_id=doctor.id,
        token=doctor.calendar_token,
        feed_path=feed_path(doctor.calendar_token),
    )


@router.get("/{doctor_id}/calendar-feed", response_model=CalendarFeedOut)
def get_calendar_feed(
    doctor_id: int,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
) -> CalendarFeedOut:
    """The doctor's feed token and path, readable at every access tier.

    Deliberately not doctor-scoped: the feed is identified by its token, not
    by who is logged in, and every rota surface in the app is already
    readable at every tier. Any logged-in user picks a doctor from the
    calendar page and copies that doctor's URL. The token defends against
    outsiders, not against colleagues.
    """
    return _feed_out(_get_or_404(db, doctor_id))


@router.post("/{doctor_id}/calendar-feed/rotate", response_model=CalendarFeedOut)
def rotate_calendar_feed(
    doctor_id: int,
    db: Session = Depends(get_db),
    admin: User = Depends(require_capability("user_admin")),
) -> CalendarFeedOut:
    """Issue a fresh token, dead-ending the old URL. Needs `user_admin`.

    This router's `clinical` gate is not enough on its own: it admits every
    rota editor, and this is the revocation path for a doctor's calendar
    link -- user-administration business rather than routine data entry,
    and silently destructive, since the doctor's calendar simply stops
    updating with no error anywhere. So `user_admin` hangs off the endpoint
    on top of the router's area gate, and the effective rule is the
    conjunction: clinical:write AND user_admin. It is one of only two such
    conjunctions in the API (see deps.py).

    `test_authorization.py` lists this route as needing more than its area:
    its sweep otherwise asserts a rota editor gets past the gate on every
    non-GET clinical route.
    """
    doctor = _get_or_404(db, doctor_id)
    doctor.calendar_token = new_session_token()
    db.commit()
    db.refresh(doctor)
    return _feed_out(doctor)


@router.get("/{doctor_id}/usage", response_model=DoctorUsageOut)
def doctor_usage(
    doctor_id: int,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
) -> DoctorUsageOut:
    """What deleting this doctor would destroy.

    Readable at every tier like any other GET in this router -- it is the
    confirm dialog's input, and the dialog is worth reading only if the
    numbers in it are real.

    The counts themselves are `_doctors.doctor_usage_counts`, shared with the
    nurse staff router, which documents why these eight tables and not the
    other ten the delete also purges.
    """
    return doctor_usage_counts(db, _get_or_404(db, doctor_id))


@router.delete("/{doctor_id}", response_model=DoctorDeleteOut)
def delete_doctor(
    doctor_id: int,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
    admin: User = Depends(require_capability("user_admin")),
) -> DoctorDeleteOut:
    """Permanently remove a doctor and every row that references them.

    Irreversible; see the module docstring for why it purges rather than
    refuses, why it needs `user_admin` as well as clinical:write, and why
    it only accepts an already-inactive doctor.
    """
    doctor = _get_or_404(db, doctor_id)
    if doctor.active:
        raise HTTPException(
            status_code=409,
            detail=(
                f"Doctor '{doctor.code}' is active -- deactivate before deleting"
            ),
        )

    counts = purge_doctor(db, doctor)
    db.commit()

    return DoctorDeleteOut(deleted=counts)
