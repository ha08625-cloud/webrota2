"""Doctor router.

**DELETE means delete.** Deactivation is `PATCH {"active": false}`, and the
two are not the same call. This used to be a soft delete that 409'd against
committed rotas; a deactivated doctor kept every row they had, which is why
they went on appearing on the master rota grid flagged "(inactive)" long
after someone thought they had removed them. Deleting now purges the doctor
row and every row that references it, matching routers/reception_staff.py --
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

The child rows are deleted explicitly (PURGED_MODELS) rather than by
`ondelete="CASCADE"` on the FKs: no migration, and the destruction is
visible at the point it is decided rather than a schema property some
unrelated future code path could trigger. The cost is that a table added
later with a doctor FK would not be purged, so PURGED_MODELS is asserted
against the metadata by tests/test_api/test_doctors.py.

`users.doctor_id` is the one referencing column the delete nulls rather
than purges: a user row is a login, not history of the doctor. NULLED_TABLES
records that so the FK-coverage tripwire covers it without the delete ever
destroying a login. `rota_generation_log` is untouched and not in either
list: its doctor_id is deliberately FK-free (see models/generation_log.py),
its rows carry self-contained prose, and it is purged with its rota.

`generated_rotas` headers are left standing even where the purge empties
one, the same call reception_staff.py makes for `reception_rotas`.

Counter invariant: every doctor row has exactly one SystemCounter row per
SystemCounterType (room_move, supervision), created here at doctor creation
regardless of doctor_type. Trainee/AHP rows sit unused at zero -- the cost
of a handful of dead rows buys a single unconditional invariant, closing
the PATCH edge case where a doctor's type changes to Partner/Salaried after
creation. `generate._write_counters` relies on this invariant via a strict
`.scalar_one()` and 500s the generation if it is ever violated. It has
been violated before, by doctor rows created before the invariant existed
-- seed/backfill_system_counters.py is the repair for that case.

Calendar-token invariant: every doctor row also has a unique, unguessable
`calendar_token` from creation, set here explicitly. It is the identifier of
that doctor's public .ics feed, so the feed route can look it up through the
unique index with no null branch. Unlike the counter invariant this one has
no history of being violated -- migration 007 backfills a token per existing
row and makes the column NOT NULL, so no database can hold a doctor without
one. The token is deliberately absent from DoctorOut/DoctorDetailOut: it
reaches the frontend only through the dedicated calendar-feed endpoint, so it
never travels in the rota grid's caches or the audit log's request bodies.

Token management (read the feed URL, rotate the token) lives here rather
than on the public calendar router, so it sits behind the ordinary session
gate. Rotation additionally carries `require_capability("user_admin")` on
top of that -- see its docstring.
"""
from __future__ import annotations

import datetime

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import delete, distinct, func, select, update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from ...models import (
    BlockedEntry,
    ClinicCounter,
    ClinicTypeDoctorEligibility,
    Doctor,
    DoctorPreferredRoom,
    DoctorSignature,
    DutyAssignment,
    ExtraSessionEntry,
    GeneratedRota,
    LeaveEntitlement,
    LeaveEntry,
    MasterRotaSession,
    RecurringNoteDoctor,
    RotaClinicCounterSnapshot,
    RotaConfigNoteDoctor,
    RotaSession,
    RotaStagingSession,
    RotaSystemCounterSnapshot,
    SystemCounter,
    User,
)
from ...models.enums import RotaStatus, SystemCounterType
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
from .calendar import feed_path

router = APIRouter(prefix="/doctors", tags=["doctors"])

# Every table that must be purged when a Doctor row is deleted, in delete
# order (nothing here references anything else here, so the order is only
# for readability). test_doctors.py asserts this covers every FK targeting
# doctors -- see the module docstring. Adding a model here is the only edit
# a future doctor-referencing table needs: both the delete and its response
# counts are derived from this tuple.
PURGED_MODELS = (
    DoctorPreferredRoom,
    ClinicTypeDoctorEligibility,
    ClinicCounter,
    SystemCounter,
    RotaClinicCounterSnapshot,
    RotaSystemCounterSnapshot,
    LeaveEntry,
    LeaveEntitlement,
    BlockedEntry,
    ExtraSessionEntry,
    DutyAssignment,
    MasterRotaSession,
    RotaStagingSession,
    RotaSession,
    RecurringNoteDoctor,
    RotaConfigNoteDoctor,
    DoctorSignature,
)

# Tables that reference doctors but are *nulled*, not purged, by the delete.
# `users` is the only one: a user row is a login, not history of the doctor,
# so destroying it would be catastrophic rather than merely wrong. Kept out
# of PURGED_MODELS (and out of the response counts, which report destroyed
# history) but named here so the FK-coverage tripwire in
# tests/test_api/test_doctors.py still has exactly one correct answer for
# every table that references doctors.
NULLED_TABLES = ("users",)


def _validate_window(
    start: datetime.date | None, end: datetime.date | None
) -> None:
    """Enforce start <= end on the employment window.

    Lives here rather than in a schema validator because a PATCH may supply
    only one end of the pair -- the check needs the merged post-update
    values, which only the router has.
    """
    if start is not None and end is not None and start > end:
        raise HTTPException(
            status_code=422, detail="start_date must not be after end_date"
        )


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
    _validate_window(payload.start_date, payload.end_date)
    doctor = Doctor(
        code=payload.code,
        doctor_type=payload.doctor_type,
        sessions_per_week=payload.sessions_per_week,
        supervision_preference=payload.supervision_preference,
        active=True,
        start_date=payload.start_date,
        end_date=payload.end_date,
        calendar_token=new_session_token(),
    )
    db.add(doctor)
    try:
        # Flush (rather than commit) first: it assigns doctor.id for the
        # counter rows below, and surfaces a duplicate-code IntegrityError
        # before any counter rows are staged.
        db.flush()
        for counter_type in (SystemCounterType.ROOM_MOVE, SystemCounterType.SUPERVISION):
            db.add(
                SystemCounter(
                    doctor_id=doctor.id, counter_type=counter_type, raw_count=0
                )
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
    _validate_window(
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


@router.put("/{doctor_id}/preferred-rooms", response_model=DoctorDetailOut)
def replace_preferred_rooms(
    doctor_id: int,
    payload: list[PreferredRoomIn],
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
) -> Doctor:
    doctor = _get_or_404(db, doctor_id)
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

    Not every purged table is counted. These seven are the ones a person
    deciding would recognise as history of their own; the counters,
    snapshots, preferences, eligibilities and note pickers the delete also
    removes are consequences of those rows rather than separate losses, and
    listing seventeen numbers would bury the two that matter
    (`committed_rotas` and `rota_sessions`).
    """
    doctor = _get_or_404(db, doctor_id)

    def _count(model) -> int:
        return db.execute(
            select(func.count()).select_from(model).where(model.doctor_id == doctor.id)
        ).scalar_one()

    committed_rotas = db.execute(
        select(func.count(distinct(RotaSession.rota_id)))
        .select_from(RotaSession)
        .join(GeneratedRota, RotaSession.rota_id == GeneratedRota.id)
        .where(
            RotaSession.doctor_id == doctor.id,
            GeneratedRota.status == RotaStatus.COMMITTED,
        )
    ).scalar_one()

    return DoctorUsageOut(
        master_sessions=_count(MasterRotaSession),
        rota_sessions=_count(RotaSession),
        committed_rotas=committed_rotas,
        staging_sessions=_count(RotaStagingSession),
        leave_entries=_count(LeaveEntry),
        duty_assignments=_count(DutyAssignment),
        extra_sessions=_count(ExtraSessionEntry),
        blocked_entries=_count(BlockedEntry),
    )


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

    # Core deletes rather than loading rows and db.delete()-ing them one at
    # a time: GeneratedRota.sessions (and several others here) carry
    # cascade="all, delete-orphan", so a bulk delete that tried to
    # synchronise a loaded parent's collection is a footgun worth ruling out
    # explicitly.
    # Drop the login link first (NULLED_TABLES): users are not purged, and
    # the FK would otherwise block the delete of the doctor row below.
    db.execute(
        update(User)
        .where(User.doctor_id == doctor.id)
        .values(doctor_id=None)
        .execution_options(synchronize_session=False)
    )

    counts: dict[str, int] = {}
    for model in PURGED_MODELS:
        result = db.execute(
            delete(model)
            .where(model.doctor_id == doctor.id)
            .execution_options(synchronize_session=False)
        )
        counts[model.__tablename__] = result.rowcount
    db.delete(doctor)
    db.commit()

    return DoctorDeleteOut(deleted=counts)
