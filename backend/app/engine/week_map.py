"""Week mapping: generation weeks <-> template weeks <-> calendar dates.

The master rota template has a fixed 4-week cycle (`week` 1..4 on
`MasterRotaSession`). A generation run starts at an arbitrary point in that
cycle (`RotaConfig.template_start_week`) and runs for `num_weeks` (1, 2, or
4) *generation* weeks, numbered 1..num_weeks from the run's own start date.
`template_week()` maps a generation week back onto the 4-week template cycle.
"""
from __future__ import annotations

from datetime import date, timedelta

from ..models.enums import Day

# Monday..Friday offsets in days from the week's Monday.
_DAY_OFFSETS: dict[Day, int] = {
    Day.MONDAY: 0,
    Day.TUESDAY: 1,
    Day.WEDNESDAY: 2,
    Day.THURSDAY: 3,
    Day.FRIDAY: 4,
}


def template_week(gen_week: int, start_week: int) -> int:
    """Map a 1-indexed generation week onto the 1..4 template cycle.

    `gen_week` is 1-indexed (the run's first week is 1, not 0).
    `start_week` is `RotaConfig.template_start_week`, itself 1..4.
    """
    return ((start_week - 1 + gen_week - 1) % 4) + 1


def build_week_dates(start_date: date, num_weeks: int) -> dict[tuple[int, Day], date]:
    """Build `(gen_week, day) -> calendar date` for every weekday in the run.

    `start_date` must be a Monday (validated by Phase 0, not here — this
    function trusts its input).
    """
    week_dates: dict[tuple[int, Day], date] = {}
    for gen_week in range(1, num_weeks + 1):
        week_monday = start_date + timedelta(days=(gen_week - 1) * 7)
        for day, offset in _DAY_OFFSETS.items():
            week_dates[(gen_week, day)] = week_monday + timedelta(days=offset)
    return week_dates


def build_date_to_genslot(
    week_dates: dict[tuple[int, Day], date]
) -> dict[date, tuple[int, Day]]:
    """Invert `week_dates` for the reverse lookup used by Phase 4 (duty)."""
    return {d: genslot for genslot, d in week_dates.items()}