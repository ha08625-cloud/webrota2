"""Rebuild a RotaGrid from persisted RotaSession rows (M3).

The generation engine builds its grid in Phase 2 and discards it after
writing to the DB. The API's /issues and swap endpoints need to re-run
Phase 12 against the *current* DB state (including manual swap edits), so
this module reconstructs an equivalent grid from RotaSession rows.

A fresh GenerationContext is built per call (M3 plan, resolution 5) -- no
caching. The context is also returned because Phase 12 needs it.

Template type (M3.7): row.template_type is trusted when present -- it was
persisted at generation time (M3.6) and reflects the template as it stood
then, not as it stands now. This matters beyond cosmetics: Phase 12's
role_on_incompatible_slot check (M3.7) judges edits against this value, so
re-deriving from the *current* active template would let a template edit
made after generation silently change which past edits register as
warnings. Falls back to re-deriving from the active template (as this
module did before M3.6) only for legacy rows with no persisted value, and
falls back further to NO_SURGERY if the active template no longer has a
matching entry either -- unchanged from the original behaviour, and still
only reachable for pre-M3.6 data.

template_room_id has no persisted equivalent (M3.6 only added
template_type) and is always derived from the *current* active template
regardless. This is lower-stakes than it sounds: nothing in this
reconstruction path actually reads template_room_id downstream -- Phase 12
only reads assigned_room_id, and the pre-occupying-room logic that does
read template_room_id lives in phase2.py's fresh-generation path, never
called from here.
"""
from __future__ import annotations

from sqlalchemy import select
from sqlalchemy.orm import Session

from ..models import GeneratedRota, RotaConfig, RotaSession
from ..models.enums import MasterSessionType
from .context import load_context
from .datatypes import GenerationContext, RotaGrid, SessionSlot, ValidationIssue
from .phases import run_phase12
from .week_map import template_week


def rebuild_rota_grid(
    db: Session, rota_id: int
) -> tuple[GenerationContext, RotaGrid]:
    """Reconstruct the grid for a persisted rota from its RotaSession rows.

    Raises ValueError if the rota does not exist (router maps to 404).
    """
    rota = db.get(GeneratedRota, rota_id)
    if rota is None:
        raise ValueError(f"GeneratedRota id={rota_id} not found")
    config = db.get(RotaConfig, rota.config_id)

    context = load_context(db, config)

    rows = db.execute(
        select(RotaSession).where(RotaSession.rota_id == rota_id)
    ).scalars().all()

    grid = RotaGrid()
    for row in rows:
        tw = template_week(row.week, config.template_start_week)
        template_entry = context.template_sessions.get(
            (row.doctor_id, tw, row.day, row.period)
        )
        template_room_id = template_entry[1] if template_entry is not None else None

        if row.template_type is not None:
            template_type = row.template_type
        elif template_entry is not None:
            template_type = template_entry[0]
        else:
            template_type = MasterSessionType.NO_SURGERY

        session_date = context.week_dates.get((row.week, row.day))
        is_on_leave = (
            session_date is not None
            and (row.doctor_id, session_date, row.period) in context.leave_set
        )

        slot = SessionSlot(
            doctor_id=row.doctor_id,
            week=row.week,
            day=row.day,
            period=row.period,
            template_type=template_type,
            template_room_id=template_room_id,
            clinic_type_id=row.clinic_type_id,
            role=row.role,
            is_on_leave=is_on_leave,
            is_wfh=row.is_wfh,
            notes=row.notes,
        )
        grid.add_slot(slot)
        # assign_room (rather than setting assigned_room_id directly) keeps
        # both occupancy indexes populated, matching a Phase-2-built grid.
        if row.room_id is not None:
            grid.assign_room(row.week, row.day, row.period, row.doctor_id, row.room_id)

    return context, grid


def run_phase12_for_rota(db: Session, rota_id: int) -> list[ValidationIssue]:
    """Rebuild the grid for a rota and re-run Phase 12 validation."""
    context, grid = rebuild_rota_grid(db, rota_id)
    return run_phase12(context, grid)