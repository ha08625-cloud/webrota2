"""Formatting helpers for `DecisionLogEntry.rationale`.

`message` answers "what did the engine do here"; `rationale` answers "why
did it do that, rather than the alternative". Every rationale is built the
same way: one line per stage of the selection, in the order the phase
actually applied them, ending with a `Decided on:` line naming the stage
that settled it. A reader debugging a run should be able to tell from a
single entry whether the priority tiers, the weighted counters, or the
alphabetical fallback produced the outcome -- without inferring it from
which doctor happened to be picked.

Nothing here parses; these strings are for humans. They are stored
verbatim in `rota_generation_log.rationale` and rendered as-is by the
frontend's `GenerationLogPanel`, which is why every line is
self-contained (doctor codes and room codes, never bare ids).

Conventions the phases follow:
  - `stages()` drops empty lines, so a caller can pass a conditional line
    as `... if cond else None` without branching.
  - A weighted score is always shown with the raw count and the
    sessions-per-week it was divided by (`score()`), because "AA 0.100"
    alone does not distinguish a doctor with one session from a doctor
    with ten.
  - An infinite score (`spw == 0`, see `CounterState.weighted_*_score`)
    prints as `no sessions/week` rather than `inf` -- it is a data
    problem on the doctor record, and reads as one.
"""
from __future__ import annotations

import math
from typing import Iterable


def stages(*lines: str | None) -> str | None:
    """Join the non-empty stage lines into one rationale block.

    Returns `None` when nothing survives, so a caller that has nothing to
    explain stores a NULL rationale rather than an empty string.
    """
    kept = [line for line in lines if line]
    return "\n".join(kept) if kept else None


def listing(label: str, items: Iterable[str]) -> str:
    """`"Label (2): a; b"`, or `"Label: none"` for an empty sequence.

    Semicolons separate entries because individual entries routinely
    contain commas ("AA (tier 1, 0.100)").
    """
    values = list(items)
    if not values:
        return f"{label}: none"
    return f"{label} ({len(values)}): " + "; ".join(values)


def score(raw: int, spw: float, weighted: float) -> str:
    """`"raw 3 / 6.0 sessions per week = 0.500"`.

    Shows the whole division rather than just its result: fairness
    complaints are almost always really about the denominator.
    """
    if math.isinf(weighted):
        return f"raw {raw}, no sessions/week recorded -> score undefined"
    return f"raw {raw} / {spw:g} sessions per week = {weighted:.3f}"


def fmt(weighted: float) -> str:
    """A weighted score on its own, for lines that have already shown the
    raw counts."""
    return "undefined" if math.isinf(weighted) else f"{weighted:.3f}"


def decided(stage: str) -> str:
    """The closing line every selection rationale ends with."""
    return f"Decided on: {stage}."


# Stage names, so the phases cannot describe the same tie-break two
# different ways. Referenced by the tests as the canonical spellings.
ONLY_CANDIDATE = "only one candidate, no comparison needed"
PRIORITY_TIER = "priority tier"
WEIGHTED_COUNTER = "weighted counter"
ALPHABETICAL = "alphabetical order of doctor code (fully tied on every earlier stage)"
PREFERENCE_ORDER = "position in the doctor's room preference list"
