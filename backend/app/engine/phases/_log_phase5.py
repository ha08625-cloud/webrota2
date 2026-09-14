"""Decision-log narration for Phase 5 (clinic type assignment).

Two accounts live here. The first explains *who* got the clinic: the
eligible field with each doctor's tier and weighted counter, the doctors
ruled out and why, and the stage that settled it. The second explains
*which room* they got, and who was moved out of it.

`_displaceability` sits in this module rather than in `phase5.py` even
though the phase's own search calls it: it returns `(can we take this
room, and if not why not)`, and the "why not" only exists for the log.
Keeping the test and its explanation in one function is what stops the
room list from claiming a room was protected when the search treated it as
free.

`ClinicRoomNarrator` is an object for the usual reason: it snapshots the
eligible-room list before the search moves anybody, and collects the dead
ends as the search hits them, so the entry written at the end describes
the world the search actually faced.
"""
from __future__ import annotations

from typing import TYPE_CHECKING

from ...models.enums import SessionRole
from .. import rationale as rat
from ..datatypes import ClinicTypeInfo, DecisionLog, GenerationContext, RotaGrid
from ._shared import code

if TYPE_CHECKING:  # the scored field lives with the sort that consumes it
    from .phase5 import _Candidate

# Owned here rather than in `phase5.py` so the narration can stamp it
# without importing its caller; the phase imports it back from here.
PHASE = "phase5"


def clinic_name(context: GenerationContext, clinic_type_id: int) -> str:
    for clinic in context.clinic_types:
        if clinic.id == clinic_type_id:
            return clinic.name
    return f"clinic type id={clinic_type_id}"


def excluded_lines(excluded: list[tuple[str, str]]) -> list[str]:
    return [f"{doctor_code}: {reason}" for doctor_code, reason in excluded]


# ---------------------------------------------------------------------------
# Who got the clinic
# ---------------------------------------------------------------------------

def _selection_reason(candidates: list[_Candidate]) -> str:
    """The one-line reason embedded in the entry's `message`. Mirrors the
    sort key `candidates` is already ordered by: priority tier, then
    weighted counter score, then alphabetical. `_selection_rationale`
    expands the same comparison into the full stage-by-stage account."""
    if len(candidates) == 1:
        return "only eligible doctor"

    a, b = candidates[0], candidates[1]
    if a.tier != b.tier:
        return f"priority tier {a.tier}"
    if a.weighted != b.weighted:
        return (
            f"priority tier {a.tier}, tie broken on weighted "
            f"score {a.weighted:.2f} vs {b.weighted:.2f}"
        )
    return f"priority tier {a.tier}, alphabetical tie-break"


def _selection_rationale(
    candidates: list[_Candidate], excluded: list[tuple[str, str]]
) -> str:
    """The full account of a clinic assignment: the eligible field, who was
    ruled out and why, the top tier, the counter comparison inside it, and
    the decisive stage.

    Stages are emitted only up to the one that decided -- if the top tier
    holds a single doctor, no counter line is written, because no counter
    was consulted. Reading a run's log, the presence of a line is itself
    the evidence that the stage ran.
    """
    chosen = candidates[0]
    lines: list[str | None] = [
        rat.listing(
            "Eligible",
            [
                f"{c.code} (priority tier {c.tier}, {rat.score(c.raw, c.spw, c.weighted, c.balance)})"
                for c in candidates
            ],
        ),
        rat.listing("Not eligible", excluded_lines(excluded)) if excluded else None,
    ]

    top_tier = [c for c in candidates if c.tier == chosen.tier]
    if len(candidates) == 1:
        lines.append(rat.decided(f"{rat.ONLY_CANDIDATE} -- {chosen.code}"))
        return rat.stages(*lines)

    lines.append(rat.listing(
        f"Top priority tier {chosen.tier}", [c.code for c in top_tier]
    ))
    if len(top_tier) == 1:
        lines.append(rat.decided(
            f"{rat.PRIORITY_TIER} -- {chosen.code} is alone in tier {chosen.tier}"
        ))
        return rat.stages(*lines)

    lines.append(rat.listing(
        "Weighted clinic counters within that tier",
        [f"{c.code} {rat.score(c.raw, c.spw, c.weighted, c.balance)}" for c in top_tier],
    ))
    tied = [c for c in top_tier if c.weighted == chosen.weighted]
    if len(tied) == 1:
        lines.append(rat.decided(
            f"{rat.WEIGHTED_COUNTER} -- {chosen.code} has the lowest weighted "
            f"count, {rat.fmt(chosen.weighted)}"
        ))
        return rat.stages(*lines)

    lines.append(rat.listing(
        f"Still tied on weighted count {rat.fmt(chosen.weighted)}",
        [c.code for c in tied],
    ))
    lines.append(rat.decided(f"{rat.ALPHABETICAL} -- {chosen.code}"))
    return rat.stages(*lines)


def skipped_closed_date(
    log: DecisionLog, gen_week: int, day, period, clinic: ClinicTypeInfo, date_,
) -> None:
    log.add(
        phase=PHASE, action="skip_closed_date",
        week=gen_week, day=day, period=period, clinic_type_id=clinic.id,
        message=(
            f"Skipped clinic '{clinic.name}' on "
            f"{date_.isoformat()} {period.value}: practice "
            f"closed."
        ),
    )


def no_eligible_doctor(
    log: DecisionLog, gen_week: int, day, period, clinic: ClinicTypeInfo, date_,
    excluded: list[tuple[str, str]],
) -> None:
    """Logged as well as warned: the warning says nobody was available, this
    says which configured doctors were considered and what ruled each of
    them out, which is the actual question being asked when it fires."""
    log.add(
        phase=PHASE, action="no_eligible_doctor",
        week=gen_week, day=day, period=period, clinic_type_id=clinic.id,
        message=(
            f"No eligible doctor for clinic '{clinic.name}' on "
            f"{date_.isoformat()} {period.value}; slot left "
            f"unassigned."
        ),
        rationale=rat.stages(
            rat.listing(
                "Doctors configured as eligible for this clinic type",
                excluded_lines(excluded),
            ),
            "Every configured doctor was ruled out, so there was "
            "no field to compare.",
        ),
    )


def clinic_assigned(
    log: DecisionLog, context: GenerationContext, gen_week: int, day, period,
    clinic: ClinicTypeInfo, date_, candidates: list[_Candidate],
    excluded: list[tuple[str, str]],
) -> None:
    """`candidates` must already be in the order the phase sorted them --
    `candidates[0]` is the doctor that was assigned."""
    doctor_id = candidates[0].doctor_id
    log.add(
        phase=PHASE, action="assign_clinic",
        week=gen_week, day=day, period=period, doctor_id=doctor_id,
        clinic_type_id=clinic.id,
        message=(
            f"Assigned clinic '{clinic.name}' to "
            f"{code(context, doctor_id)} on {date_.isoformat()} "
            f"{period.value} ({_selection_reason(candidates)})."
        ),
        rationale=_selection_rationale(candidates, excluded),
    )


# ---------------------------------------------------------------------------
# Which room they got
# ---------------------------------------------------------------------------

def displaceability(
    context: GenerationContext,
    grid: RotaGrid,
    clinic_priority_by_id: dict[int, int],
    occupant_id: int,
    gen_week: int,
    day,
    period,
    current_clinic_priority: int,
) -> tuple[bool, str]:
    """`(displaceable, reason)` -- the reason names the protection that
    fired, and is only meaningful when `displaceable` is False."""
    slot = grid.get(occupant_id, gen_week, day, period)
    if slot is None:
        return False, "no session slot for that doctor this session"
    if slot.is_on_leave:
        return False, "protected: on leave"
    if slot.role in (SessionRole.DUTY_PRIMARY, SessionRole.DUTY_SECONDARY):
        return False, f"protected: on {slot.role.value}"
    if slot.role == SessionRole.CLINIC:
        occupant_priority = clinic_priority_by_id.get(slot.clinic_type_id)
        if occupant_priority is not None and occupant_priority < current_clinic_priority:
            # Protected: occupant's clinic is higher priority (lower number).
            return False, (
                f"protected: running '{clinic_name(context, slot.clinic_type_id)}' "
                f"at clinic priority {occupant_priority}, ahead of this clinic's "
                f"{current_clinic_priority}"
            )
    return True, "displaceable"


class ClinicRoomNarrator:
    """One clinic's room search. Construct before touching the grid."""

    def __init__(
        self, context: GenerationContext, grid: RotaGrid, log: DecisionLog,
        clinic: ClinicTypeInfo, doctor_id: int, gen_week: int, day, period,
        eligible_room_ids: list[int], clinic_priority_by_id: dict[int, int],
    ) -> None:
        self._context = context
        self._log = log
        self._clinic = clinic
        self._doctor_id = doctor_id
        self._week = gen_week
        self._day = day
        self._period = period
        # Snapshot the room list before anything moves, so every entry below
        # explains itself against the state the search actually faced.
        self._rooms_line = rat.listing(
            f"Rooms eligible for clinic '{clinic.name}' (searched in room-id order)",
            _room_states(
                context, grid, eligible_room_ids, gen_week, day, period,
                clinic_priority_by_id, clinic.clinic_priority,
            ),
        )
        self._attempts: list[str] = []

    def _room(self, room_id: int) -> str:
        return self._context.room_by_id[room_id].code

    def _add(self, action: str, message: str, rationale: str | None, **fields) -> None:
        self._log.add(
            phase=PHASE, action=action, week=self._week, day=self._day,
            period=self._period, doctor_id=self._doctor_id,
            clinic_type_id=self._clinic.id, message=message, rationale=rationale,
            **fields,
        )

    # -- capture points ----------------------------------------------------

    def note_room_protected(self, room_id: int, why: str) -> None:
        self._attempts.append(f"{self._room(room_id)}: cannot take it -- {why}")

    def note_occupant_stuck(
        self, room_id: int, occupant_id: int, exclude_d: bool
    ) -> None:
        self._attempts.append(
            f"{self._room(room_id)}: {code(self._context, occupant_id)} could be "
            f"displaced but has no free preferred room to move to"
            + (" (D rooms excluded)" if exclude_d else "")
        )

    # -- outcomes ----------------------------------------------------------

    def already_in_eligible_room(self, room_id: int) -> None:
        self._add(
            "assign_clinic_room", room_id=room_id,
            message=(
                f"{code(self._context, self._doctor_id)} already in eligible room "
                f"{self._room(room_id)} for clinic "
                f"'{self._clinic.name}'."
            ),
            rationale=rat.stages(
                self._rooms_line,
                rat.decided(
                    f"no search run -- {code(self._context, self._doctor_id)} already held "
                    f"{self._room(room_id)}, which is on that list"
                ),
            ),
        )

    def assigned_free_room(self, room_id: int) -> None:
        self._add(
            "assign_clinic_room", room_id=room_id,
            message=(
                f"Assigned room {self._room(room_id)} to "
                f"{code(self._context, self._doctor_id)} for clinic '{self._clinic.name}'."
            ),
            rationale=rat.stages(
                self._rooms_line,
                rat.decided(
                    f"first free room in that list -- "
                    f"{self._room(room_id)}; no displacement needed"
                ),
            ),
        )

    def displaced_occupant(
        self, occupant_id: int, room_id: int, new_room: int
    ) -> None:
        self._add(
            "displace_for_clinic", related_doctor_id=occupant_id,
            room_id=room_id, related_room_id=new_room,
            message=(
                f"Displaced {code(self._context, occupant_id)} from "
                f"{self._room(room_id)} to "
                f"{self._room(new_room)} so "
                f"{code(self._context, self._doctor_id)} can run clinic "
                f"'{self._clinic.name}'."
            ),
            rationale=rat.stages(
                self._rooms_line,
                "No eligible room was free, so the list was walked again for a "
                "displaceable occupant.",
                rat.listing("Rooms tried and rejected first", self._attempts)
                if self._attempts else None,
                rat.decided(
                    f"first eligible room whose occupant could both be displaced and "
                    f"rehoused -- {self._room(room_id)}; "
                    f"{code(self._context, occupant_id)} moved to "
                    f"{self._room(new_room)}, the first free room on their "
                    f"own preference list"
                ),
            ),
        )

    def unresolved(self) -> None:
        self._add(
            "clinic_room_unresolved",
            message=(
                f"No eligible room could be found or freed for "
                f"{code(self._context, self._doctor_id)} on clinic "
                f"'{self._clinic.name}'; left in their current room."
            ),
            rationale=rat.stages(
                self._rooms_line,
                rat.listing("Rooms tried for displacement", self._attempts),
                rat.decided("nothing left to try -- every eligible room was occupied "
                            "and none of the occupants could be displaced and rehoused"),
            ),
        )


def _room_states(
    context: GenerationContext,
    grid: RotaGrid,
    room_ids: list[int],
    gen_week: int,
    day,
    period,
    clinic_priority_by_id: dict[int, int],
    current_clinic_priority: int,
) -> list[str]:
    """One `"R1: free"` / `"R1: held by AB, displaceable"` line per eligible
    room, in the order the search walks them."""
    states = []
    for room_id in room_ids:
        room_code = context.room_by_id[room_id].code
        occupant_id = grid.get_room_occupant(gen_week, day, period, room_id)
        if occupant_id is None:
            states.append(f"{room_code}: free")
            continue
        can_displace, why = displaceability(
            context, grid, clinic_priority_by_id, occupant_id, gen_week, day, period,
            current_clinic_priority,
        )
        states.append(
            f"{room_code}: held by {code(context, occupant_id)}, "
            + ("displaceable" if can_displace else why)
        )
    return states


__all__ = [
    "PHASE", "ClinicRoomNarrator", "clinic_assigned", "clinic_name",
    "displaceability", "excluded_lines", "no_eligible_doctor",
    "skipped_closed_date",
]
