"""Reception staff router: CRUD plus a permanent delete.

**DELETE means delete.** Deactivation is `PATCH {"active": false}`, and the
two are no longer the same call. This diverges from routers/doctors.py,
where DELETE is a soft delete that 409s against committed rotas -- a reader
moving between the two routers should expect the difference rather than
assume it.

The delete purges history; it does not refuse to run. Removing a staff
member deletes their rows from every already-generated day, so a day rota
printed months ago will no longer match what the app shows, and the counters
window loses that person entirely. There is no way around this:
`reception_rota_sessions.staff_id` is non-nullable, and an orphan row with no
name attached is worse than no row. The alternative -- blocking deletion for
anyone with generated-day rows -- was rejected because it would make anyone
who has actually worked a day undeletable, which is precisely the
retiring-staff case this exists for. The mitigations are informed consent in
the UI and the audit log, which records who deleted which staff id even
though the rows themselves are gone.

Two guards stand in front of it:

- **Manager only.** The reception routers are write-gated globally (admin
  and manager) at include_router time; this one endpoint additionally carries
  `Depends(require_manager)`, the per-endpoint pattern routers/users.py and
  routers/audit.py use. An irreversible, history-destroying action should be
  the narrower permission. Deactivate stays open to admins.
- **409 unless the member is already inactive.** Deleting is a deliberate
  two-step: deactivate, then later delete. This matches the retiring-staff
  workflow and removes the "deleted someone who is on today's rota" case
  entirely. Unlike a has-history guard it never makes anyone permanently
  undeletable -- deactivate is always available -- so it costs one extra
  click and nothing else.

The child rows are deleted explicitly here rather than by
`ondelete="CASCADE"` on the FKs: no migration, and the destruction is visible
at the point it is decided rather than a property of the schema that some
unrelated future code path could trigger. The cost is that a table added
later with a staff FK would not be purged, so PURGED_MODELS below is asserted
against the metadata by tests/test_api/test_reception_staff.py.

`reception_rotas` headers are left standing even when the purge empties one:
an empty header already means "generated, then every row deleted", as
distinct from "never generated" (see models/reception.py), and deleting it
would destroy that distinction and change what the day page offers.

GET defaults to active-only but, unlike DoctorsPage, exposes an
include_inactive flag -- the reception staff list is the only management
surface here, so it must also offer a way back to reactivate someone.
"""
from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import delete, distinct, func, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from ...models import (
    ReceptionLeaveEntry,
    ReceptionMasterSession,
    ReceptionRota,
    ReceptionRotaSession,
    ReceptionStaff,
    User,
)
from ..deps import get_current_user, get_db, require_manager
from ..schemas import (
    ReceptionStaffDeletedCounts,
    ReceptionStaffDeleteOut,
    ReceptionStaffIn,
    ReceptionStaffOut,
    ReceptionStaffPatch,
    ReceptionStaffUsageOut,
)

router = APIRouter(prefix="/reception/staff", tags=["reception"])

# Every table that must be purged when a ReceptionStaff row is deleted, in
# delete order. test_reception_staff.py asserts this covers every FK
# targeting reception_staff -- see the module docstring. Adding a model here
# is the only edit a future staff-referencing table needs: both the delete
# and the response counts are derived from this tuple.
PURGED_MODELS = (
    ReceptionLeaveEntry,
    ReceptionMasterSession,
    ReceptionRotaSession,
)


def _get_or_404(db: Session, staff_id: int) -> ReceptionStaff:
    staff = db.get(ReceptionStaff, staff_id)
    if staff is None:
        raise HTTPException(
            status_code=404, detail=f"Reception staff {staff_id} not found"
        )
    return staff


@router.get("", response_model=list[ReceptionStaffOut])
def list_staff(
    include_inactive: bool = False,
    db: Session = Depends(get_db),
    user: dict = Depends(get_current_user),
) -> list[ReceptionStaff]:
    stmt = select(ReceptionStaff).order_by(ReceptionStaff.code)
    if not include_inactive:
        stmt = stmt.where(ReceptionStaff.active.is_(True))
    return db.execute(stmt).scalars().all()


@router.post("", response_model=ReceptionStaffOut, status_code=201)
def create_staff(
    payload: ReceptionStaffIn,
    db: Session = Depends(get_db),
    user: dict = Depends(get_current_user),
) -> ReceptionStaff:
    staff = ReceptionStaff(code=payload.code, active=True)
    db.add(staff)
    try:
        db.commit()
    except IntegrityError as exc:
        db.rollback()
        raise HTTPException(
            status_code=409,
            detail=f"Reception staff name '{payload.code}' already exists",
        ) from exc
    db.refresh(staff)
    return staff


@router.patch("/{staff_id}", response_model=ReceptionStaffOut)
def patch_staff(
    staff_id: int,
    payload: ReceptionStaffPatch,
    db: Session = Depends(get_db),
    user: dict = Depends(get_current_user),
) -> ReceptionStaff:
    staff = _get_or_404(db, staff_id)
    fields = payload.model_fields_set
    if "code" in fields and payload.code is not None:
        staff.code = payload.code
    if "active" in fields and payload.active is not None:
        staff.active = payload.active
    try:
        db.commit()
    except IntegrityError as exc:
        db.rollback()
        raise HTTPException(
            status_code=409, detail="Reception staff name already exists"
        ) from exc
    db.refresh(staff)
    return staff


@router.get("/{staff_id}/usage", response_model=ReceptionStaffUsageOut)
def staff_usage(
    staff_id: int,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
) -> ReceptionStaffUsageOut:
    """What deleting this staff member would destroy. Readable at every tier
    like any other GET -- it is the confirm dialog's input, and the dialog is
    worth reading only if the numbers in it are real. Kept off
    `GET /reception/staff` deliberately: folding these in would mean N+1
    aggregates on every page load for data that matters on one click."""
    staff = _get_or_404(db, staff_id)

    def _count(model) -> int:
        return db.execute(
            select(func.count()).select_from(model).where(model.staff_id == staff.id)
        ).scalar_one()

    generated_days = db.execute(
        select(func.count(distinct(ReceptionRota.date)))
        .select_from(ReceptionRotaSession)
        .join(ReceptionRota, ReceptionRotaSession.rota_id == ReceptionRota.id)
        .where(ReceptionRotaSession.staff_id == staff.id)
    ).scalar_one()

    return ReceptionStaffUsageOut(
        master_sessions=_count(ReceptionMasterSession),
        rota_sessions=_count(ReceptionRotaSession),
        generated_days=generated_days,
        leave_entries=_count(ReceptionLeaveEntry),
    )


@router.delete("/{staff_id}", response_model=ReceptionStaffDeleteOut)
def delete_staff(
    staff_id: int,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
    manager: User = Depends(require_manager),
) -> ReceptionStaffDeleteOut:
    """Permanently remove a staff member and every row that references them.
    Irreversible; see the module docstring for why it purges rather than
    refuses, and why it is manager-only and inactive-only."""
    staff = _get_or_404(db, staff_id)
    if staff.active:
        raise HTTPException(
            status_code=409,
            detail=(
                f"Reception staff '{staff.code}' is active -- deactivate "
                "before deleting"
            ),
        )

    # Core deletes rather than loading rows and db.delete()-ing them one at a
    # time: ReceptionRota.sessions carries cascade="all, delete-orphan", so a
    # bulk delete that tried to synchronise a loaded parent's collection is a
    # footgun worth ruling out explicitly.
    counts: dict[str, int] = {}
    for model in PURGED_MODELS:
        result = db.execute(
            delete(model)
            .where(model.staff_id == staff.id)
            .execution_options(synchronize_session=False)
        )
        counts[model.__tablename__.removeprefix("reception_")] = result.rowcount
    db.delete(staff)
    db.commit()

    return ReceptionStaffDeleteOut(deleted=ReceptionStaffDeletedCounts(**counts))
