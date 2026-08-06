"""Master rota template lookups shared by two routers (no-surgery leave
exemption plan, Task 1).

Pure logic with nowhere else to live given there is no services layer --
`app/leave_planning.py`'s coverage endpoint and `app/leave.py`'s
chargeable-count endpoint both need the same week-1 template map, and
this module is where that shared piece lives so the two definitions of
"working" (coverage vs. charging, Design Decision 2) can each build on it
without duplicating the query. Top-level under `app/` for that reason
alone -- unlike `doctor_window.py`, nothing under `engine/` imports this.
"""
from __future__ import annotations

from sqlalchemy import select
from sqlalchemy.orm import Session

from .engine.week_map import DAY_ORDER
from .models import MasterRotaSession, MasterRotaTemplate
from .models.enums import Day, MasterSessionType, Period

WEEKDAY_MAX = 4  # Mon=0 ... Fri=4 (Python date.weekday())

# `date.weekday()` -> Day, inverted from week_map's canonical ordering.
# Module-local rather than a new shared helper: the engine maps generation
# weeks onto dates, never a bare calendar date onto a template day, so
# there is nothing here for it to reuse.
DAY_BY_WEEKDAY: dict[int, Day] = {offset: day for day, offset in DAY_ORDER.items()}


def load_week_one_template(db: Session) -> dict[tuple[int, Day, Period], MasterSessionType]:
    """The active template's week-1 rows, keyed (doctor_id, day, period).

    Week 1 only, and treated as the working pattern for every calendar date
    (Design Decision 1): mapping a date onto the 4-week cycle needs a
    `start_week`, and the only source of one is `RotaConfig.template_start_week`
    -- a per-run value with no calendar anchor. Partner, salaried, and locum
    doctors work the same sessions every week, so week 1 is the right answer
    for leave planning even though the schema keeps four weeks.

    The template is resolved the way `GET /master-rota/active` resolves it
    -- lowest id among active rows -- because `is_active` is not
    schema-enforced unique and this endpoint must not 500 where that one
    renders. No active template at all yields an empty map, so every slot
    reports a headcount of 0 and the grid still draws its leave cells.

    Also serves leave charging (no-surgery leave exemption plan), which
    reads the same map to decide whether a booked leave slot was one the
    doctor was actually due to work.
    """
    template = db.execute(
        select(MasterRotaTemplate)
        .where(MasterRotaTemplate.is_active.is_(True))
        .order_by(MasterRotaTemplate.id)
    ).scalars().first()
    if template is None:
        return {}

    rows = db.execute(
        select(MasterRotaSession).where(
            MasterRotaSession.template_id == template.id,
            MasterRotaSession.week == 1,
        )
    ).scalars().all()
    return {(r.doctor_id, r.day, r.period): r.session_type for r in rows}
