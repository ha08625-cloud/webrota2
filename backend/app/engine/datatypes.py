"""Core data structures used by the generation engine.

These types are the shared vocabulary between the phases (`phases/*.py`),
the orchestrator (`generate.py`), and the context loader (`context.py`).
Nothing in this module touches the database — `SessionSlot`/`RotaGrid`/
`CounterState` are plain in-memory structures built and mutated by the
phases, and `GenerationContext` is a read-only snapshot assembled once by
`context.load_context()`.

Clinic counters are shared per (doctor, clinic_type) — there is no
day/period dimension. This clinic-scoped-only design (not per-slot) was
confirmed before M2 as the correct approach for fair allocation across
multiple schedule slots per clinic type.
"""
from __future__ import annotations

import math
from dataclasses import dataclass, field
from datetime import date
from typing import Literal

from ..models import Doctor, MasterRotaTemplate, Room
from ..models.enums import (
    Day,
    DutyType,
    MasterSessionType,
    Period,
    RoomType,
    SessionRole,
    SystemCounterType,
)


# ---------------------------------------------------------------------------
# Validation issues
# ---------------------------------------------------------------------------

@dataclass(frozen=True)
class ValidationIssue:
    """One finding raised by a phase.

    Only Phase 0 emits `severity="error"` (which aborts generation before any
    write). Every other phase emits `severity="warning"`; warnings are
    collected and returned but never abort the run.
    """
    severity: Literal["error", "warning"]
    phase: str
    check: str
    message: str
    week: int | None = None
    day: Day | None = None
    period: Period | None = None


# ---------------------------------------------------------------------------
# Decision log
# ---------------------------------------------------------------------------

@dataclass(frozen=True)
class DecisionLogEntry:
    """One decision made by a phase during generation.

    Sibling type to `ValidationIssue`: a `ValidationIssue` is a finding
    ("something is wrong"); a `DecisionLogEntry` is a record of the normal
    path ("this happened"). Persisted verbatim to `rota_generation_log` by
    `generate._write_to_db()` -- see that table's model docstring for the
    persistence conventions (plain integer ids, no FKs except rota_id;
    immutable after generation).

    `message` says *what* happened in one line. `rationale` says *why*: a
    multi-line, stage-by-stage replay of the selection the phase performed
    (who was in the running, who was filtered out and on what grounds,
    what each stage compared, and which stage was decisive), built by the
    helpers in `engine/rationale.py`. It is optional -- entries recording
    something that involved no choice (a skipped closed date, a WFH
    abandonment) leave it `None` -- and it is never parsed: it exists to
    be read by a human debugging a run, which is why it duplicates figures
    that also appear in `message`.
    """
    sequence: int
    phase: str
    action: str
    message: str
    week: int | None = None
    day: Day | None = None
    period: Period | None = None
    doctor_id: int | None = None
    related_doctor_id: int | None = None
    room_id: int | None = None
    related_room_id: int | None = None
    clinic_type_id: int | None = None
    rationale: str | None = None


@dataclass
class DecisionLog:
    """Append-only collector threaded through the decision-making phases
    (4, 5, 7-9A, 9B, 9C), mirroring how `CounterState` is threaded through
    the same phases rather than returned and re-passed.

    `sequence` is assigned here, monotonically per run, starting at 0 --
    DB row order is never relied on for replay order, since `sequence` is
    also the column the log table is ordered and uniquely constrained by.
    """
    entries: list[DecisionLogEntry] = field(default_factory=list)

    def add(self, *, phase: str, action: str, message: str, **fields) -> None:
        self.entries.append(DecisionLogEntry(
            sequence=len(self.entries), phase=phase, action=action,
            message=message, **fields,
        ))


# ---------------------------------------------------------------------------
# Rota grid
# ---------------------------------------------------------------------------

@dataclass
class SessionSlot:
    """One (doctor, generation week, day, period) position in the grid."""

    doctor_id: int
    week: int
    day: Day
    period: Period

    # From the master template (set once in Phase 2, never mutated after).
    template_type: MasterSessionType
    template_room_id: int | None = None

    # Set during generation.
    assigned_room_id: int | None = None
    clinic_type_id: int | None = None
    role: SessionRole | None = None
    is_on_leave: bool = False
    is_wfh: bool = False
    notes: str | None = None
    is_supervising: bool = False

    @property
    def key(self) -> tuple[int, int, Day, Period]:
        return (self.doctor_id, self.week, self.day, self.period)

    @property
    def has_role(self) -> bool:
        """True once the doctor is committed to a duty or clinic role.

        Used by later phases to exclude doctors who are already spoken for
        in this slot (e.g. Phase 5 must not assign a clinic to a doctor
        already on duty in the same session).
        """
        return self.role is not None


@dataclass
class RotaGrid:
    """All `SessionSlot`s for one generation run, plus room occupancy.

    Two occupancy indexes are kept in sync so both "is this room free right
    now" and "what room is this doctor in right now" are O(1) lookups:
      - `_room_occupancy`: (week, day, period, room_id) -> doctor_id
      - `_doctor_room`:     (week, day, period, doctor_id) -> room_id
    """

    slots: dict[tuple[int, int, Day, Period], SessionSlot] = field(default_factory=dict)
    _room_occupancy: dict[tuple[int, Day, Period, int], int] = field(
        default_factory=dict, repr=False
    )
    _doctor_room: dict[tuple[int, Day, Period, int], int] = field(
        default_factory=dict, repr=False
    )

    def add_slot(self, slot: SessionSlot) -> None:
        self.slots[slot.key] = slot

    def get(self, doctor_id: int, week: int, day: Day, period: Period) -> SessionSlot | None:
        return self.slots.get((doctor_id, week, day, period))

    def sessions_for_slot(self, week: int, day: Day, period: Period) -> list[SessionSlot]:
        return [
            s for s in self.slots.values()
            if s.week == week and s.day == day and s.period == period
        ]

    def is_room_free(self, week: int, day: Day, period: Period, room_id: int) -> bool:
        return (week, day, period, room_id) not in self._room_occupancy

    def get_room_occupant(self, week: int, day: Day, period: Period, room_id: int) -> int | None:
        """The doctor_id currently occupying `room_id` in this slot, if any.

        Added in M2 step 6 -- Phase 5's room displacement needs to know *who*
        occupies a room, not just whether it's free.
        """
        return self._room_occupancy.get((week, day, period, room_id))

    def get_doctor_room(self, week: int, day: Day, period: Period, doctor_id: int) -> int | None:
        return self._doctor_room.get((week, day, period, doctor_id))

    def assign_room(
        self, week: int, day: Day, period: Period, doctor_id: int, room_id: int
    ) -> None:
        """Assign `room_id` to `doctor_id` in this slot.

        Frees the doctor's previous room in this slot first (a no-op if they
        had none), then claims the new room, updating both indexes and the
        slot's `assigned_room_id`.
        """
        self.free_room(week, day, period, doctor_id)
        self._room_occupancy[(week, day, period, room_id)] = doctor_id
        self._doctor_room[(week, day, period, doctor_id)] = room_id
        slot = self.get(doctor_id, week, day, period)
        if slot is not None:
            slot.assigned_room_id = room_id

    def free_room(self, week: int, day: Day, period: Period, doctor_id: int) -> None:
        """Vacate whatever room `doctor_id` currently holds in this slot, if any."""
        room_id = self._doctor_room.pop((week, day, period, doctor_id), None)
        if room_id is not None:
            self._room_occupancy.pop((week, day, period, room_id), None)
        slot = self.get(doctor_id, week, day, period)
        if slot is not None:
            slot.assigned_room_id = None


# ---------------------------------------------------------------------------
# Counters
# ---------------------------------------------------------------------------

@dataclass
class CounterState:
    """Working copy of clinic and system counters, loaded once from the DB.

    `clinic` is keyed `(doctor_id, clinic_type_id)` — shared across all of a
    clinic type's schedule slots, per the M1/M2 design decision. `system` is
    keyed `(doctor_id, SystemCounterType)`.

    All mutation happens in memory; nothing is persisted until
    `generate._write_to_db` runs after a successful pipeline.
    """

    clinic: dict[tuple[int, int], int] = field(default_factory=dict)
    system: dict[tuple[int, SystemCounterType], int] = field(default_factory=dict)
    clinic_balance: dict[tuple[int, int], float] = field(default_factory=dict)
    system_balance: dict[tuple[int, SystemCounterType], float] = field(default_factory=dict)
    _new_clinic_keys: set[tuple[int, int]] = field(default_factory=set, repr=False)

    def clinic_opening_balance(self, doctor_id: int, clinic_type_id: int) -> float:
        """The credited opening balance, 0.0 when none is stored."""
        return self.clinic_balance.get((doctor_id, clinic_type_id), 0.0)

    def system_opening_balance(
        self, doctor_id: int, counter_type: SystemCounterType
    ) -> float:
        """The credited opening balance, 0.0 when none is stored."""
        return self.system_balance.get((doctor_id, counter_type), 0.0)

    def weighted_clinic_score(self, doctor_id: int, clinic_type_id: int, spw: float) -> float:
        """`(raw + opening balance) / sessions_per_week`.

        Missing key treated as raw=0 and balance=0.0. spw=0 -> inf. The
        balance is a credit in sessions for a mid-year joiner, so they start
        level with their peers instead of at zero; `increment_clinic` never
        touches it, which is what keeps the draft snapshot contract (raw
        counts only) true.
        """
        if spw == 0:
            return math.inf
        raw = self.clinic.get((doctor_id, clinic_type_id), 0)
        return (raw + self.clinic_opening_balance(doctor_id, clinic_type_id)) / spw

    def weighted_system_score(
        self,
        doctor_id: int,
        counter_type: SystemCounterType,
        spw: float,
        multiplier: float = 1.0,
    ) -> float:
        """`(raw + opening balance) / spw`, scaled by `multiplier`.

        `spw=0` -> inf regardless of `multiplier` -- an undefined score stays
        undefined. `multiplier` is currently only passed by Phase 9C
        (supervision-preference weighting of the SUPERVISION counter);
        ROOM_MOVE callers pass nothing and get the unscaled score, unchanged
        from before this parameter existed. See `weighted_clinic_score` for
        what the opening balance is and why it is held apart from `raw`.
        """
        if spw == 0:
            return math.inf
        raw = self.system.get((doctor_id, counter_type), 0)
        return ((raw + self.system_opening_balance(doctor_id, counter_type)) / spw) * multiplier

    def increment_clinic(self, doctor_id: int, clinic_type_id: int) -> None:
        key = (doctor_id, clinic_type_id)
        if key not in self.clinic:
            self._new_clinic_keys.add(key)
        self.clinic[key] = self.clinic.get(key, 0) + 1

    def increment_system(self, doctor_id: int, counter_type: SystemCounterType) -> None:
        key = (doctor_id, counter_type)
        self.system[key] = self.system.get(key, 0) + 1

    def is_new_clinic_key(self, doctor_id: int, clinic_type_id: int) -> bool:
        """True if this (doctor, clinic_type) pair has no existing DB row.

        `_write_to_db` uses this to decide INSERT vs UPDATE. System counters
        never need this: M1's `seed_system_counters` guarantees a row for
        every active doctor and counter type up front.
        """
        return (doctor_id, clinic_type_id) in self._new_clinic_keys


# ---------------------------------------------------------------------------
# Generation context (reference data, read-only for the whole run)
# ---------------------------------------------------------------------------

@dataclass(frozen=True)
class ClinicSchedule:
    day: Day
    period: Period


@dataclass(frozen=True)
class ClinicDoctorEligibility:
    doctor_id: int
    doctor_priority: int


@dataclass(frozen=True)
class ClinicTypeInfo:
    """Denormalised view of one enabled `ClinicType` for the engine.

    `eligible_room_ids` has `ClinicTypeRoomEligibility.room_type` entries
    already expanded to concrete room IDs, so phases never need to touch
    `rooms_by_type` when resolving a clinic's room eligibility.
    """
    id: int
    name: str
    clinic_priority: int
    room_required: bool
    schedules: tuple[ClinicSchedule, ...]
    doctor_eligibilities: tuple[ClinicDoctorEligibility, ...]
    eligible_room_ids: tuple[int, ...]


@dataclass(frozen=True)
class GenerationContext:
    """Immutable reference data for one generation run, loaded once.

    Built by `context.load_context()` (M2 step 2). Nothing here is mutated
    during generation — mutable state lives in `RotaGrid` and `CounterState`.
    """
    doctors: tuple[Doctor, ...]
    doctor_by_id: dict[int, Doctor]
    spw_by_id: dict[int, float]

    rooms: tuple[Room, ...]
    room_by_id: dict[int, Room]
    rooms_by_type: dict[RoomType, tuple[Room, ...]]

    # doctor_id -> room_ids in preference order, room_type entries already
    # expanded to concrete rooms (sorted by id) at that preference position.
    # Added in M2 step 6 for Phase 5's displacement logic.
    preferred_rooms_by_doctor: dict[int, tuple[int, ...]]

    # Enabled only, ordered by clinic_priority ascending.
    clinic_types: tuple[ClinicTypeInfo, ...]

    leave_set: frozenset[tuple[int, date, Period]]
    duty_map: dict[tuple[date, Period, DutyType], int]

    # Pre-resolved recurring-note text per grid slot, keyed by *generation*
    # week -- the template-week mapping and the multi-note concatenation are
    # both done in load_context(), so Phase 2 is a single dict lookup.
    # Absent key means no note; the value is never an empty string.
    recurring_notes_by_slot: dict[tuple[int, int, Day, Period], str]

    # M5/half-day closures: (date, period) pairs the practice is closed
    # within this run's range, and, per generation week, the first weekday
    # with *neither* period closed (None if every weekday in the week has
    # at least one period closed). Note "slot" here means (date, period),
    # not the (week, day, period) triple `SessionSlot`/`sessions_for_slot`
    # use elsewhere in the engine -- the collision is tolerated for
    # consistency with the `/closures` API's field name. Phase 2 builds no
    # slot for a closed (date, period); Phase 12 uses
    # first_open_weekday_by_week to relocate the secondary-duty expectation
    # off a fully or partly closed Monday. Populated from PracticeClosure by
    # context.load_context() for a fresh generation run, and overridden from
    # the RotaClosure snapshot by grid_utils.rebuild_rota_grid() when
    # reconstructing a persisted rota, so a closure added or removed after
    # generation cannot change how an existing draft/committed rota renders
    # or validates.
    closed_slots: frozenset[tuple[date, Period]]
    first_open_weekday_by_week: dict[int, Day | None]

    week_dates: dict[tuple[int, Day], date]
    date_to_genslot: dict[date, tuple[int, Day]]

    template_sessions: dict[
        tuple[int, int, Day, Period], tuple[MasterSessionType, int | None]
    ]
    active_template: MasterRotaTemplate | None


# ---------------------------------------------------------------------------
# Result
# ---------------------------------------------------------------------------

@dataclass(frozen=True)
class GenerationResult:
    rota_id: int | None
    issues: tuple[ValidationIssue, ...]
    status: Literal["success", "partial", "failed"]