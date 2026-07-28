"""Phase 2 -- build the RotaGrid from the active master template, and load
the working copy of the counters.

This is the foundation every later phase reads from and mutates. Nothing is
resolved here beyond what the template already states: `REQUIRES_ROOM` slots
are created with `assigned_room_id=None` and left for Phases 5/7-9A. A
PRE_ASSIGNED/ADMIN_TIME slot claims its template_room_id immediately -- unless
the slot is on leave, in which case the slot is still created (with
template_type/template_room_id intact) but the room claim is skipped, freeing
the room for later phases to assign elsewhere.

Also stamps `SessionSlot.notes` from `context.recurring_notes_by_slot`, if
any recurring note matches -- a default value only, annotation-only, with no
effect on eligibility or room resolution. See architecture.md "Recurring
notes" section for implementation details.
"""
from __future__ import annotations

from sqlalchemy import select
from sqlalchemy.orm import Session

from ...doctor_window import is_within_window
from ...models import ClinicCounter, RotaConfig, SystemCounter
from ...models.enums import Day, MasterSessionType, Period
from ..datatypes import CounterState, GenerationContext, RotaGrid, SessionSlot
from ..week_map import template_week

_DAYS = (Day.MONDAY, Day.TUESDAY, Day.WEDNESDAY, Day.THURSDAY, Day.FRIDAY)
_PERIODS = (Period.AM, Period.PM)

# Template types whose template_room_id, if present, represents an already-
# occupied room from the start of generation (as opposed to REQUIRES_ROOM,
# where a room is resolved later, or NO_SURGERY/WFH, which never have one).
_PRE_OCCUPYING_TYPES = frozenset({MasterSessionType.PRE_ASSIGNED, MasterSessionType.ADMIN_TIME})


def run_phase2(
    context: GenerationContext, config: RotaConfig, db: Session
) -> tuple[RotaGrid, CounterState]:
    grid = _build_grid(context, config)
    counters = _load_counter_state(db)
    return grid, counters


def _build_grid(context: GenerationContext, config: RotaConfig) -> RotaGrid:
    grid = RotaGrid()

    for gen_week in range(1, config.num_weeks + 1):
        tw = template_week(gen_week, config.template_start_week)

        for doctor in context.doctors:
            for day in _DAYS:
                for period in _PERIODS:
                    entry = context.template_sessions.get((doctor.id, tw, day, period))
                    if entry is None:
                        # No template row for this doctor/slot -- e.g. a
                        # part-time doctor with no session this period.
                        # Nothing to schedule; no slot is created.
                        continue

                    template_type, template_room_id = entry
                    date_ = context.week_dates[(gen_week, day)]
                    if not is_within_window(doctor, date_):
                        # Annual leave planning, Design Decision 7: a doctor
                        # outside their employment window gets no slot on
                        # this date. Same "cell absence is data" mechanism
                        # as the two skips around it, so no downstream phase
                        # needs a per-slot window check. Independent of
                        # `active` (see doctor_window's docstring) --
                        # context.doctors already applies that filter.
                        continue
                    if (date_, period) in context.closed_slots:
                        # M5: no session on a closed (date, period). Skip the
                        # slot entirely -- cell absence is data (as with a
                        # part-time doctor's missing template row), so
                        # downstream phases need no per-slot closed checks.
                        # Checked per period: an open AM still gets a slot
                        # when only the day's PM is closed.
                        continue
                    is_on_leave = (doctor.id, date_, period) in context.leave_set
                    is_wfh = template_type == MasterSessionType.WFH

                    slot = SessionSlot(
                        doctor_id=doctor.id, week=gen_week, day=day, period=period,
                        template_type=template_type, template_room_id=template_room_id,
                        is_on_leave=is_on_leave, is_wfh=is_wfh,
                        notes=context.recurring_notes_by_slot.get(
                            (doctor.id, gen_week, day, period)
                        ),
                    )
                    grid.add_slot(slot)

                    if (
                        template_room_id is not None
                        and template_type in _PRE_OCCUPYING_TYPES
                        and not is_on_leave
                    ):
                        grid.assign_room(gen_week, day, period, doctor.id, template_room_id)

    return grid


def _load_counter_state(db: Session) -> CounterState:
    """Load every existing ClinicCounter/SystemCounter row into a working copy.

    Clinic counters not yet in the DB are simply absent from `counters.clinic`
    -- `CounterState.weighted_clinic_score` and `.increment_clinic` both treat
    a missing key as `raw=0`, and `_write_to_db` (step 9) uses
    `is_new_clinic_key` to decide INSERT vs UPDATE for those.
    """
    counters = CounterState()
    for row in db.execute(select(ClinicCounter)).scalars().all():
        counters.clinic[(row.doctor_id, row.clinic_type_id)] = row.raw_count
    for row in db.execute(select(SystemCounter)).scalars().all():
        counters.system[(row.doctor_id, row.counter_type)] = row.raw_count
    return counters