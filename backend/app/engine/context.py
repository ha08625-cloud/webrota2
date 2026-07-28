"""Load all reference data for one generation run into a `GenerationContext`.

Runs once per `generate()` call, before any phase executes. This is a
read-only snapshot: nothing here mutates the database, and the returned
`GenerationContext` is frozen. Mutable generation state (the grid, the
counters) is built separately in Phase 2.
"""
from __future__ import annotations

from collections import defaultdict
from datetime import timedelta

from sqlalchemy import select
from sqlalchemy.orm import Session, selectinload

from ..models import (
    ClinicType,
    Doctor,
    DoctorPreferredRoom,
    DutyAssignment,
    LeaveEntry,
    MasterRotaSession,
    MasterRotaTemplate,
    PracticeClosure,
    RecurringNote,
    Room,
    RotaConfig,
    RotaStaging,
    RotaStagingSession,
)
from ..models.enums import Day, Period, RoomType
from .datatypes import (
    ClinicDoctorEligibility,
    ClinicSchedule,
    ClinicTypeInfo,
    GenerationContext,
)
from .week_map import (
    DAY_ORDER,
    build_date_to_genslot,
    build_first_open_weekday,
    build_week_dates,
    template_week,
)

_PERIOD_ORDER = {Period.AM: 0, Period.PM: 1}


def load_context(db: Session, config: RotaConfig) -> GenerationContext:
    """Build the immutable reference-data snapshot for a generation run.

    `config` supplies `start_date`, `num_weeks`, and `template_start_week`.
    Leave, duty, and practice-closure data are filtered to the run's date
    range: the half-open interval
    `[config.start_date, config.start_date + num_weeks * 7 days)`.
    """
    doctors_all = db.execute(select(Doctor)).scalars().all()
    doctor_by_id = {d.id: d for d in doctors_all}
    spw_by_id = {d.id: float(d.sessions_per_week) for d in doctors_all}
    # Only active doctors are candidates for any assignment. Inactive doctors
    # still need to be reachable via doctor_by_id/spw_by_id so Phase 0 can
    # flag a template referencing one.
    doctors = tuple(sorted((d for d in doctors_all if d.active), key=lambda d: d.code))

    rooms = tuple(db.execute(select(Room)).scalars().all())
    room_by_id = {r.id: r for r in rooms}
    rooms_by_type = _group_rooms_by_type(rooms)

    clinic_types = _load_clinic_types(db, rooms_by_type)
    preferred_rooms_by_doctor = _load_preferred_rooms(db, rooms_by_type)

    range_start = config.start_date
    range_end = config.start_date + timedelta(days=config.num_weeks * 7)

    leave_rows = db.execute(
        select(LeaveEntry).where(
            LeaveEntry.date >= range_start, LeaveEntry.date < range_end
        )
    ).scalars().all()
    leave_set = frozenset((e.doctor_id, e.date, e.period) for e in leave_rows)

    duty_rows = db.execute(
        select(DutyAssignment).where(
            DutyAssignment.date >= range_start, DutyAssignment.date < range_end
        )
    ).scalars().all()
    duty_map = {(d.date, d.period, d.duty_type): d.doctor_id for d in duty_rows}

    closure_rows = db.execute(
        select(PracticeClosure).where(
            PracticeClosure.date >= range_start, PracticeClosure.date < range_end
        )
    ).scalars().all()
    closed_slots = frozenset((c.date, c.period) for c in closure_rows)

    week_dates = build_week_dates(config.start_date, config.num_weeks)
    date_to_genslot = build_date_to_genslot(week_dates)
    first_open_weekday_by_week = build_first_open_weekday(week_dates, closed_slots)

    active_template, template_sessions = _load_staging_or_template(db, config)

    effective_start_week = _effective_template_start_week(db, config)
    recurring_notes_by_slot = _load_recurring_notes(db, config, effective_start_week)

    return GenerationContext(
        doctors=doctors,
        doctor_by_id=doctor_by_id,
        spw_by_id=spw_by_id,
        rooms=rooms,
        room_by_id=room_by_id,
        rooms_by_type=rooms_by_type,
        preferred_rooms_by_doctor=preferred_rooms_by_doctor,
        clinic_types=clinic_types,
        leave_set=leave_set,
        duty_map=duty_map,
        closed_slots=closed_slots,
        first_open_weekday_by_week=first_open_weekday_by_week,
        week_dates=week_dates,
        date_to_genslot=date_to_genslot,
        template_sessions=template_sessions,
        active_template=active_template,
        recurring_notes_by_slot=recurring_notes_by_slot,
    )


def _group_rooms_by_type(rooms: tuple[Room, ...]) -> dict[RoomType, tuple[Room, ...]]:
    grouped: dict[RoomType, list[Room]] = defaultdict(list)
    for r in rooms:
        grouped[r.room_type].append(r)
    return {rt: tuple(rs) for rt, rs in grouped.items()}


def _load_clinic_types(
    db: Session, rooms_by_type: dict[RoomType, tuple[Room, ...]]
) -> tuple[ClinicTypeInfo, ...]:
    """Enabled clinic types only, ordered by `clinic_priority` ascending.

    `id` is a secondary sort key purely for deterministic ordering when two
    clinic types share a priority; it has no meaning to the generation
    algorithm itself.
    """
    rows = db.execute(
        select(ClinicType)
        .where(ClinicType.is_enabled.is_(True))
        .options(
            selectinload(ClinicType.schedules),
            selectinload(ClinicType.doctor_eligibilities),
            selectinload(ClinicType.room_eligibilities),
        )
        .order_by(ClinicType.clinic_priority.asc(), ClinicType.id.asc())
    ).scalars().all()

    infos = []
    for ct in rows:
        schedules = tuple(sorted(
            (ClinicSchedule(day=s.day, period=s.period) for s in ct.schedules),
            key=lambda cs: (DAY_ORDER[cs.day], _PERIOD_ORDER[cs.period]),
        ))
        doctor_eligibilities = tuple(
            ClinicDoctorEligibility(doctor_id=e.doctor_id, doctor_priority=e.doctor_priority)
            for e in ct.doctor_eligibilities
        )

        room_ids: set[int] = set()
        for re in ct.room_eligibilities:
            if re.room_id is not None:
                room_ids.add(re.room_id)
            elif re.room_type is not None:
                room_ids.update(r.id for r in rooms_by_type.get(re.room_type, ()))

        infos.append(
            ClinicTypeInfo(
                id=ct.id,
                name=ct.name,
                clinic_priority=ct.clinic_priority,
                room_required=ct.room_required,
                schedules=schedules,
                doctor_eligibilities=doctor_eligibilities,
                eligible_room_ids=tuple(sorted(room_ids)),
            )
        )
    return tuple(infos)


def _load_active_template(
    db: Session,
) -> tuple[MasterRotaTemplate | None, dict]:
    """Load the single active `MasterRotaTemplate`, if there is exactly one.

    Zero or more-than-one active templates are both ambiguous states that
    Phase 0 must abort generation for (single-active-template is enforced in
    app logic, not the schema — see master_rota.py). Both cases are signalled
    the same way here: `(None, {})`. Phase 0 checks `active_template is None`
    and does not need to distinguish "zero" from "more than one" — the fix
    in either case is to correct the template data, not something the
    generation run can resolve itself.
    """
    active = db.execute(
        select(MasterRotaTemplate).where(MasterRotaTemplate.is_active.is_(True))
    ).scalars().all()

    if len(active) != 1:
        return None, {}

    template = active[0]
    session_rows = db.execute(
        select(MasterRotaSession).where(MasterRotaSession.template_id == template.id)
    ).scalars().all()
    template_sessions = {
        (s.doctor_id, s.week, s.day, s.period): (s.session_type, s.room_id)
        for s in session_rows
    }
    return template, template_sessions


def _load_staging_or_template(
    db: Session, config: RotaConfig
) -> tuple[MasterRotaTemplate | None, dict]:
    """Prefer a staging copy over the live template, if one exists for this
    config (staging plan, Task 2).

    Staging rows are keyed by *generation* week, not template week, and a
    staging config always persists `template_start_week = 1` (enforced by
    the staging router, Task 3) -- so `template_week()` is the identity for
    a staging run and Phases 0/2's week mapping is a no-op. This is the
    invariant that lets the phases run unchanged against a staged copy.

    Does not check `completed_at`: this branch also fires for
    `rebuild_rota_grid()` calls made against a staging-born rota after the
    staging is completed, where the staged sessions remain the correct
    `template_sessions` source (Design Decision 6 in the plan).
    """
    staging = db.execute(
        select(RotaStaging).where(RotaStaging.config_id == config.id)
    ).scalars().first()

    if staging is None:
        return _load_active_template(db)

    template = db.get(MasterRotaTemplate, staging.source_template_id)

    session_rows = db.execute(
        select(RotaStagingSession).where(RotaStagingSession.staging_id == staging.id)
    ).scalars().all()
    template_sessions = {
        (s.doctor_id, s.week, s.day, s.period): (s.session_type, s.room_id)
        for s in session_rows
    }
    return template, template_sessions


def _effective_template_start_week(db: Session, config: RotaConfig) -> int:
    """The template week a generation run should treat as its anchor.

    For a normal (non-staged) run this is simply `config.template_start_week`.
    For a staged run, `config.template_start_week` is always persisted as 1
    by `routers/staging.py` (Design Decision 4 in the staging plan) -- that
    normalisation is what lets `week_map.template_week()` be the identity
    for a staged run, so Phases 0-12 need no staging-specific code. But it
    also destroys the record of which template week the staging copy
    actually started from, which recurring-note week resolution needs to
    get right (recurring notes plan, Design Decision 5): a note scoped to
    template weeks {1,3} must fire on the correct real-world fortnight, not
    on staging *generation* weeks 1 and 3.
    `RotaStaging.source_template_start_week` is where that original anchor
    survives, so it is used here instead when a staging exists for this
    config.

    This re-queries `rota_stagings` rather than threading a third value out
    of `_load_staging_or_template()` -- one extra query against a
    single-row-per-config table, in exchange for leaving that function's
    signature and docstring untouched.
    """
    staging = db.execute(
        select(RotaStaging).where(RotaStaging.config_id == config.id)
    ).scalars().first()
    if staging is None:
        return config.template_start_week
    return staging.source_template_start_week


def _load_recurring_notes(
    db: Session, config: RotaConfig, start_week: int
) -> dict[tuple[int, int, Day, Period], str]:
    """Pre-resolve recurring-note text for every (doctor, gen_week, day,
    period) slot it could apply to, so Phase 2 is a single dict lookup.

    Notes are iterated in ascending `id` order so that multiple notes
    landing on the same slot concatenate deterministically (recurring notes
    plan, Design Decision 9 -- overlapping notes concatenate rather than
    collide). Inactive notes are excluded outright. Doctor-active status is
    deliberately not checked here: Phase 2 only ever builds slots for active
    doctors, so an entry keyed to an inactive doctor is simply a dead key
    that costs nothing (Design Decision 12).
    """
    notes = db.execute(
        select(RecurringNote)
        .where(RecurringNote.is_active.is_(True))
        .options(
            selectinload(RecurringNote.doctors),
            selectinload(RecurringNote.weeks),
        )
        .order_by(RecurringNote.id.asc())
    ).scalars().all()

    by_slot: dict[tuple[int, int, Day, Period], list[str]] = defaultdict(list)
    for note in notes:
        template_weeks = {w.template_week for w in note.weeks}
        for gen_week in range(1, config.num_weeks + 1):
            tw = template_week(gen_week, start_week)
            if tw not in template_weeks:
                continue
            for assoc in note.doctors:
                key = (assoc.doctor_id, gen_week, note.day, note.period)
                by_slot[key].append(note.text)

    return {key: "\n".join(texts) for key, texts in by_slot.items()}


def _load_preferred_rooms(
    db: Session, rooms_by_type: dict[RoomType, tuple[Room, ...]]
) -> dict[int, tuple[int, ...]]:
    """Flatten each doctor's ordered preferred-room list to concrete room IDs.

    `room_type` rows expand to every room of that type (sorted by id) at
    that preference position. Used by Phase 5's displacement logic to find
    a bumped occupant's next room -- room *type* (not how it was originally
    referenced) is what matters there, so flattening loses no information
    the engine needs.
    """
    rows = db.execute(
        select(DoctorPreferredRoom).order_by(
            DoctorPreferredRoom.doctor_id, DoctorPreferredRoom.preference_order
        )
    ).scalars().all()

    grouped: dict[int, list[int]] = defaultdict(list)
    for row in rows:
        if row.room_id is not None:
            grouped[row.doctor_id].append(row.room_id)
        elif row.room_type is not None:
            grouped[row.doctor_id].extend(
                sorted(r.id for r in rooms_by_type.get(row.room_type, ()))
            )
    return {doctor_id: tuple(ids) for doctor_id, ids in grouped.items()}