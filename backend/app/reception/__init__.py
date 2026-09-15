"""Reception domain helpers.

Thin re-export surface for the modules in this package. The logic lives in
`counters.py` (hour arithmetic), `front_desk.py` (front-desk block
selection) and `phones.py` (the phones top-up that runs after it); nothing
is defined here.
"""

from .counters import (
    RoleCounters,
    StaffRoleCounters,
    assignment_counter_window,
    compute_role_counters,
    default_counter_window,
)
from .front_desk import (
    FRONT_DESK_END_HOUR,
    FRONT_DESK_HOURS,
    select_front_desk_blocks,
)
from .phones import select_phones_blocks

__all__ = [
    "FRONT_DESK_END_HOUR",
    "FRONT_DESK_HOURS",
    "RoleCounters",
    "StaffRoleCounters",
    "assignment_counter_window",
    "compute_role_counters",
    "default_counter_window",
    "select_front_desk_blocks",
    "select_phones_blocks",
]
