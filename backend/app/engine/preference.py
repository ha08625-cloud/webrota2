"""The preference-weight multiplier table, shared by every allocation that
weights a fairness counter by a doctor's stated preference.

It lives here rather than in any one phase because two columns now read it
-- `Doctor.supervision_preference` (Phase 9C) and `Doctor.wfh_preference`
(the future WFH allocation phase) -- and neither phase should have to import
the other. `_log_phase9c` re-exports it so that Phase 9C's invariant holds:
its selection sort and its narration must read the same numbers, and both
import the name from `_log_phase9c`.

The multipliers are direction-agnostic. Selection is lowest-score-wins
everywhere, so a multiplier above 1.0 pushes a doctor down the field
whether the thing being allocated is a burden (supervision) or a perk
(WFH); `more` means "more of it" in both cases.
"""
from __future__ import annotations

from ..models.enums import PreferenceWeight

# Deprioritises (does not exclude) candidates by preference. NONE uses a
# large finite multiplier rather than math.inf so that relative ordering
# between multiple "none"-preference doctors is preserved when they are the
# only candidates left -- math.inf would collapse them all to the
# alphabetical tiebreak regardless of their actual history.
PREFERENCE_MULTIPLIERS = {
    PreferenceWeight.NONE: 1_000_000,
    PreferenceWeight.LESS: 1.5,
    PreferenceWeight.NORMAL: 1.0,
    PreferenceWeight.MORE: 0.66,
}

__all__ = ["PREFERENCE_MULTIPLIERS"]
