"""The doctor employment window predicate (annual leave planning, Task 1).

A `Doctor` may carry an optional `start_date` / `end_date` pair; null at
either end means unbounded. Everything that asks "does this doctor work on
this date" -- the leave and extra-session entry endpoints, the leave
planning grid, the `POST /staging` copy loop, Phase 0 and Phase 2 -- goes
through `is_within_window` here rather than re-deriving the comparison, so
the rule cannot drift between the API layer and the engine.

Deliberately top-level under `app/` rather than under `app/api/`: the
engine imports it too, and `engine/` importing from `api/` would invert the
layering (the engine is pure Python with no dependency on the API).

`is_within_window` deliberately does NOT check `doctor.active`. The two are
independent gates -- `active` is the soft-delete flag, the window is a real
employment fact -- and callers combine them as they need. Phase 2 already
has its own active filter via `context.doctors`.
"""
from __future__ import annotations

import datetime
from typing import Protocol


class _HasWindow(Protocol):
    """Structural type for the two columns, so this module needs no import
    of the ORM model (and therefore no import cycle with it)."""

    code: str
    start_date: datetime.date | None
    end_date: datetime.date | None


def is_within_window(doctor: _HasWindow, day: datetime.date) -> bool:
    """True when `day` falls inside the doctor's employment window."""
    return (
        (doctor.start_date is None or doctor.start_date <= day)
        and (doctor.end_date is None or doctor.end_date >= day)
    )


def window_error_detail(doctor: _HasWindow, day: datetime.date) -> str:
    """A human message naming the doctor and the window they fall outside.

    Used verbatim as the 422 detail on the single-entry leave and
    extra-session endpoints.
    """
    if doctor.start_date is not None and doctor.end_date is not None:
        window = f"works {doctor.start_date.isoformat()} to {doctor.end_date.isoformat()}"
    elif doctor.start_date is not None:
        window = f"starts {doctor.start_date.isoformat()}"
    elif doctor.end_date is not None:
        window = f"ends {doctor.end_date.isoformat()}"
    else:  # pragma: no cover - callers only reach here for a real failure
        window = "no dates set"
    return f"Dr {doctor.code} does not work on {day.isoformat()} ({window})"
