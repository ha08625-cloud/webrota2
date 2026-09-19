"""Doctor row mechanics shared by the clinical and nurse staff routers.

Not a router -- the leading underscore marks it as internal to the routers
package (same convention as _doctor_ids.py and _uploads.py), so nothing
here is mistaken for a module with a `router` attribute to register in
main.py.

`doctors.py` still owns the *policy* (why DELETE means delete, the two
guards in front of it, the wording of each 409); this module owns the
mechanics, so that the invariants below have exactly one definition even
though two surfaces create and purge doctor rows.

Counter invariant: every doctor row has exactly one SystemCounter row per
SystemCounterType (room_move, supervision, wfh), created here at doctor
creation regardless of doctor_type. The seeding loop iterates the enum
rather than naming the types, so adding a counter type needs no edit here.
room_move and supervision rows for Trainee/AHP/Nurse staff sit unused at zero
-- the cost of a handful of dead rows buys a single unconditional
invariant, closing the PATCH edge case where a doctor's type changes to
Partner/Salaried after creation. The wfh row is the exception that shows
why the invariant is unconditional: it is written for every doctor,
because a Trainee with a WFH row in the master template works from home
like anyone else. `generate._write_counters` relies on this invariant via a strict
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
one, the same call reception/staff.py makes for `reception_rotas`.
"""
from __future__ import annotations

import datetime

from fastapi import HTTPException
from sqlalchemy import delete, update
from sqlalchemy.orm import Session

from ...models import (
    BlockedEntry,
    ClinicCounter,
    ClinicTypeDoctorEligibility,
    Doctor,
    DoctorPreferredRoom,
    DoctorSignature,
    DutyAssignment,
    DutyCounterAdjustment,
    ExtraSessionEntry,
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
from ...models.enums import DoctorType, SystemCounterType
from ..auth_utils import new_session_token

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
    DutyCounterAdjustment,
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


def validate_window(
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


def create_doctor_row(
    db: Session,
    *,
    code: str,
    doctor_type: DoctorType,
    active: bool = True,
    start_date: datetime.date | None = None,
    end_date: datetime.date | None = None,
    **model_defaults,
) -> Doctor:
    """Create a doctor row with both creation invariants satisfied.

    Commits nothing and catches nothing: a duplicate `code` surfaces as an
    `IntegrityError` for the caller to turn into a 409, because the wording
    differs by surface (the nurse endpoints say "staff", not "doctor").
    `model_defaults` passes through any remaining Doctor column -- the nurse
    surface supplies none of them and takes the model defaults instead.
    """
    doctor = Doctor(
        code=code,
        doctor_type=doctor_type,
        active=active,
        start_date=start_date,
        end_date=end_date,
        calendar_token=new_session_token(),
        **model_defaults,
    )
    db.add(doctor)
    # Flush (rather than commit) first: it assigns doctor.id for the
    # counter rows below, and surfaces a duplicate-code IntegrityError
    # before any counter rows are staged.
    db.flush()
    for counter_type in SystemCounterType:
        db.add(
            SystemCounter(doctor_id=doctor.id, counter_type=counter_type, raw_count=0)
        )
    return doctor


def purge_doctor(db: Session, doctor: Doctor) -> dict[str, int]:
    """Delete a doctor and every row that references them, returning counts.

    Does not commit, does not check `active`, and does not raise. The
    409-unless-inactive guard stays in each router's endpoint: the message
    differs by surface, and it is a policy decision each surface makes for
    itself.
    """
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
    return counts
