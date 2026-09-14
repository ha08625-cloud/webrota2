"""Decision-log narration for Phases 7-9A.

The three passes in `phase7_9a.py` each justify themselves to a partner
reading the generation log: which D rooms were free, who could have been
displaced instead, and which stage of the ranking actually settled it.
That prose used to sit inline and outweighed the algorithm roughly two to
one. It lives here instead, one narrator per pass, so `phase7_9a.py` reads
as the room-allocation algorithm it is.

**Snapshot timing is the whole reason these are objects rather than
functions.** A narrator captures the state of the world at the moment it
is constructed -- which rooms were free, who held what -- because by the
time the matching log entry is written the grid has already been mutated
and the room-move counter may already have been incremented. Building the
lines lazily at `log.add` time would produce entries describing the world
*after* the decision, which reads as though the engine chose wrongly.
Hence `note_victim_field` and `note_chosen_victim`: they exist to be
called at the exact point the phase knows something, not at the point it
reports it.

The one deliberate asymmetry preserved from the original: Pass 1 works out
its decisive stage *before* incrementing the victim's room-move counter,
Pass 2 *after*. Both are as the phases have always logged them.
"""
from __future__ import annotations

from ...models.enums import Day, Period
from .. import rationale as rat
from ..datatypes import CounterState, DecisionLog, GenerationContext, RotaGrid
from ._shared import code, room_move_rank, room_move_score_text, room_state

# Owned here rather than in `phase7_9a.py` so the narrators can stamp it
# without importing their caller; the phase imports it back from here.
PHASE = "phase7_9a"

_PERIODS = (Period.AM, Period.PM)

# What each Pass 2 displacement tier means. Keyed to
# `phase7_9a._displacement_priority`'s return values, which is the only
# thing that may define them. Pass 1 has its own two-tier scheme, spelled
# out inline in `Pass1Narrator.note_victim_field`, because its tiers are
# about holding two D rooms rather than about fragmenting a day.
TIER_MEANINGS = {
    1: "other session has no room setup to fragment",
    2: "other session is in a different room anyway",
    3: "same D room all day, so displacing them fragments their day",
}


def _victim_decisive(
    context: GenerationContext, counters: CounterState, pool: list, chosen_id: int,
) -> str:
    """Name the stage that actually picked `chosen_id` out of `pool`.

    Shared by Passes 1 and 2: both rank victims by priority tier, then live
    weighted room-move score, then doctor code, so both explain themselves
    the same way. `pool` entries are `(tier, doctor_id, ...)` in either
    pass's shape; only the first two positions are read.
    """
    chosen_code = code(context, chosen_id)
    if len(pool) == 1:
        return f"{rat.ONLY_CANDIDATE} -- {chosen_code}"

    tier = next(entry[0] for entry in pool if entry[1] == chosen_id)
    same_tier = [entry for entry in pool if entry[0] == tier]
    if len(same_tier) == 1:
        return (
            f"{rat.PRIORITY_TIER} -- {chosen_code} is alone in tier {tier} "
            f"({TIER_MEANINGS.get(tier, 'see the pass description')})"
        )

    best = room_move_rank(context, counters, chosen_id)[0]
    tied = [
        entry for entry in same_tier
        if room_move_rank(context, counters, entry[1])[0] == best
    ]
    if len(tied) == 1:
        return (
            f"{rat.WEIGHTED_COUNTER} -- inside tier {tier}, {chosen_code} has the "
            f"lowest weighted room-move score, {rat.fmt(best)}"
        )
    return (
        f"{rat.ALPHABETICAL} -- {chosen_code}, tied inside tier {tier} on a weighted "
        f"room-move score of {rat.fmt(best)}"
    )


def _d_room_states_period(
    context: GenerationContext, grid: RotaGrid,
    gen_week: int, day: Day, period: Period, d_room_ids: list[int],
) -> list[str]:
    return [
        room_state(context, grid, gen_week, day, period, room_id)
        for room_id in d_room_ids
    ]


def _d_room_states_day(
    context: GenerationContext, grid: RotaGrid,
    gen_week: int, day: Day, d_room_ids: list[int],
) -> list[str]:
    """AM and PM state of each D room -- Pass 1 needs a room free in both,
    so a per-period view alone would not explain its choices."""
    states = []
    for room_id in d_room_ids:
        room_code = context.room_by_id[room_id].code
        parts = []
        for period in _PERIODS:
            occupant_id = grid.get_room_occupant(gen_week, day, period, room_id)
            parts.append(
                f"{period.value} free" if occupant_id is None
                else f"{period.value} held by {code(context, occupant_id)}"
            )
        states.append(f"{room_code}: " + ", ".join(parts))
    return states


# ---------------------------------------------------------------------------
# Pass 1: full-day Trainee/AHP
# ---------------------------------------------------------------------------

class Pass1Narrator:
    """One full-day trainee's search, from "needs a D room" to whatever
    happened. Construct before touching the grid."""

    def __init__(
        self, context: GenerationContext, grid: RotaGrid, counters: CounterState,
        log: DecisionLog, gen_week: int, day: Day, doctor_id: int,
        d_room_ids: list[int],
    ) -> None:
        self._context = context
        self._counters = counters
        self._log = log
        self._week = gen_week
        self._day = day
        self._doctor_id = doctor_id
        self._doctor_code = code(context, doctor_id)
        self._rooms_line = rat.listing(
            "D rooms across the whole day (room-id order, the search order)",
            _d_room_states_day(context, grid, gen_week, day, d_room_ids),
        )
        self._need_line = (
            f"{self._doctor_code} is "
            f"{context.doctor_by_id[doctor_id].doctor_type.value} and needs "
            f"a D room for both sessions of {day.value}."
        )
        self._victims_line: str | None = None
        self._victim_rationale: str | None = None

    def _room(self, room_id: int) -> str:
        return self._context.room_by_id[room_id].code

    def _add(self, action: str, message: str, rationale: str | None, **fields) -> None:
        self._log.add(
            phase=PHASE, action=action, week=self._week, day=self._day,
            doctor_id=self._doctor_id, message=message, rationale=rationale, **fields,
        )

    # -- capture points ----------------------------------------------------

    def note_victim_field(self, victim_pool: list[tuple[int, int, int, int]]) -> None:
        """Record the displaceable field as it stood when it was ranked."""
        self._victims_line = rat.listing(
            "Displaceable full-day D-room holders (Partner/Salaried, role-free, "
            "not on leave), by priority tier then weighted room-move counter",
            [
                f"{code(self._context, cand_id)} (tier {tier}: "
                + (
                    f"holds {self._room(am)} AM and "
                    f"{self._room(pm)} PM, so displacing them frees two "
                    f"D rooms" if tier == 1 else
                    f"holds {self._room(am)} all day"
                )
                + f", {room_move_score_text(self._context, self._counters, cand_id)})"
                for tier, cand_id, am, pm in victim_pool
            ],
        )

    def note_chosen_victim(
        self, victim_pool: list, displaced_id: int, new_room: int,
    ) -> None:
        """Freeze the account of the displacement. Must be called before the
        victim is moved and before their room-move counter is incremented --
        `_victim_decisive` reads that counter live."""
        self._victim_rationale = rat.stages(
            self._need_line,
            self._rooms_line,
            "No D room was free in both sessions, so a full-day victim was sought.",
            self._victims_line,
            f"Receiving room for the victim: "
            f"{self._room(new_room)} -- the first C/W/SR room free in "
            f"both sessions (pass 1 does not consult the victim's own preference "
            f"list).",
            rat.decided(
                _victim_decisive(self._context, self._counters, victim_pool, displaced_id)
            ),
        )

    # -- outcomes ----------------------------------------------------------

    def free_room(self, free_room: int) -> None:
        self._add(
            "assign_room", period=None, room_id=free_room,
            message=(
                f"Assigned D room {self._room(free_room)} to "
                f"{self._doctor_code} for the full day (pass 1, "
                f"room free both sessions)."
            ),
            rationale=rat.stages(
                self._need_line,
                self._rooms_line,
                rat.decided(
                    f"first D room free in both sessions -- "
                    f"{self._room(free_room)}; nobody was displaced"
                ),
            ),
        )

    def no_victim(self) -> None:
        self._add(
            "no_full_day_room", period=None,
            message=(
                f"No free or displaceable D room for "
                f"{self._doctor_code} (full day) on {self._day.value}; "
                f"left for pass 2."
            ),
            rationale=rat.stages(
                self._rooms_line,
                "No D room was free in both sessions, so a full-day victim was "
                "sought.",
                self._victims_line,
                rat.decided(
                    "nothing left to try in this pass -- no Partner/Salaried "
                    "doctor held a D room all day while free of a role and of "
                    "leave"
                ),
            ),
        )

    def victim_not_relocatable(self, victim_pool: list, displaced_id: int) -> None:
        self._add(
            "no_full_day_room", period=None, related_doctor_id=displaced_id,
            message=(
                f"Could not relocate {code(self._context, displaced_id)} to free a "
                f"D room for {self._doctor_code} (full day) on "
                f"{self._day.value}; left for pass 2."
            ),
            rationale=rat.stages(
                self._rooms_line,
                self._victims_line,
                f"{code(self._context, displaced_id)} was chosen as the victim "
                f"({_victim_decisive(self._context, self._counters, victim_pool, displaced_id)}).",
                rat.decided(
                    "abandoned -- pass 1 rehouses a victim only into a C/W/SR "
                    "room free in both sessions (their own preference list is "
                    "deliberately not consulted here), and none was; the "
                    "displacement was rolled back rather than half-applied"
                ),
            ),
        )

    def displaced_single(
        self, displaced_id: int, room_id: int, new_room: int, tier: int,
    ) -> None:
        self._add(
            "displace_room", period=None, related_doctor_id=displaced_id,
            room_id=room_id, related_room_id=new_room,
            message=(
                f"Displaced {code(self._context, displaced_id)} from "
                f"{self._room(room_id)} to "
                f"{self._room(new_room)} to free the D room for "
                f"{self._doctor_code} (full day, pass 1, {_tier_desc(tier)})."
            ),
            rationale=self._victim_rationale,
        )

    def displaced_consolidated(
        self, displaced_id: int, am_room: int, pm_room: int, trainee_room: int,
        new_room: int, tier: int,
    ) -> None:
        self._add(
            "displace_room", period=None, related_doctor_id=displaced_id,
            room_id=trainee_room, related_room_id=new_room,
            message=(
                f"Displaced {code(self._context, displaced_id)} from "
                f"{self._room(am_room)}/{self._room(pm_room)} "
                f"to {self._room(new_room)}, vacating both rooms for "
                f"{self._doctor_code}, who consolidates into "
                f"{self._room(trainee_room)} for the full day "
                f"(full day, pass 1, {_tier_desc(tier)})."
            ),
            rationale=rat.stages(
                self._victim_rationale,
                f"The victim held two different D rooms, and "
                f"{self._room(trainee_room)} turned out to be free "
                f"in the other session as well once they left, so "
                f"{self._doctor_code} takes that one room all day rather "
                f"than being split across both.",
            ),
        )

    def displaced_split(
        self, displaced_id: int, am_room: int, pm_room: int, new_room: int, tier: int,
    ) -> None:
        """Two entries -- one per period -- for a trainee split across the
        victim's two D rooms. The room-move counter was incremented once, and
        the AM entry is the one that says so."""
        self._add(
            "displace_room", period=Period.AM, related_doctor_id=displaced_id,
            room_id=am_room, related_room_id=new_room,
            message=(
                f"Displaced {code(self._context, displaced_id)} from "
                f"{self._room(am_room)}/{self._room(pm_room)} "
                f"to {self._room(new_room)}; {self._doctor_code} "
                f"takes {self._room(am_room)} in AM (full day, pass 1, "
                f"{_tier_desc(tier)}; room-move counter incremented once for the day, "
                f"covering both periods)."
            ),
            rationale=rat.stages(
                self._victim_rationale,
                f"The victim held two different D rooms and neither was free in "
                f"the other session once they left, so "
                f"{self._doctor_code} is split across both.",
            ),
        )
        self._add(
            "displace_room", period=Period.PM, related_doctor_id=displaced_id,
            room_id=pm_room, related_room_id=new_room,
            message=(
                f"{self._doctor_code} takes "
                f"{self._room(pm_room)} in PM, completing the full-day "
                f"split freed by displacing {code(self._context, displaced_id)} "
                f"(full day, pass 1, {_tier_desc(tier)})."
            ),
            rationale=rat.stages(
                self._victim_rationale,
                "Second half of the same split; the room-move counter was "
                "incremented once, on the AM entry, for the whole day.",
            ),
        )


def _tier_desc(tier: int) -> str:
    return f"priority tier {tier}, tie broken on weighted room-move score"


# ---------------------------------------------------------------------------
# Pass 2: single-session Trainee/AHP
# ---------------------------------------------------------------------------

class Pass2Narrator:
    """One single-session trainee's search. Construct before touching the
    grid."""

    def __init__(
        self, context: GenerationContext, grid: RotaGrid, counters: CounterState,
        log: DecisionLog, gen_week: int, day: Day, period: Period, doctor_id: int,
        d_room_ids: list[int],
    ) -> None:
        self._context = context
        self._counters = counters
        self._log = log
        self._week = gen_week
        self._day = day
        self._period = period
        self._doctor_id = doctor_id
        self._doctor_code = code(context, doctor_id)
        self._rooms_line = rat.listing(
            f"D rooms in {period.value} (room-id order, the search order)",
            _d_room_states_period(context, grid, gen_week, day, period, d_room_ids),
        )
        self._need_line = (
            f"{self._doctor_code} is "
            f"{context.doctor_by_id[doctor_id].doctor_type.value} and needs a D room "
            f"for {day.value} {period.value}."
        )
        self._victims_line: str | None = None

    def _room(self, room_id: int) -> str:
        return self._context.room_by_id[room_id].code

    def _add(self, action: str, message: str, rationale: str | None, **fields) -> None:
        self._log.add(
            phase=PHASE, action=action, week=self._week, day=self._day,
            period=self._period, doctor_id=self._doctor_id, message=message,
            rationale=rationale, **fields,
        )

    def note_victim_field(self, victim_pool: list[tuple[int, int, int]]) -> None:
        """Record the displaceable field as it stood when it was ranked."""
        self._victims_line = rat.listing(
            "Displaceable D-room occupants (Partner/Salaried, role-free, not on "
            "leave), by priority tier then weighted room-move counter",
            [
                f"{code(self._context, cand_id)} in {self._room(room)} "
                f"(tier {tier}: {TIER_MEANINGS[tier]}, "
                f"{room_move_score_text(self._context, self._counters, cand_id)})"
                for tier, cand_id, room in victim_pool
            ],
        )

    def free_room(self, free_room: int) -> None:
        self._add(
            "assign_room", room_id=free_room,
            message=(
                f"Assigned D room {self._room(free_room)} to "
                f"{self._doctor_code} on {self._day.value} {self._period.value} "
                f"(pass 2, room free)."
            ),
            rationale=rat.stages(
                self._need_line,
                self._rooms_line,
                rat.decided(
                    f"first free D room -- "
                    f"{self._room(free_room)}; nobody was displaced"
                ),
            ),
        )

    def no_victim(self) -> None:
        self._add(
            "no_single_session_room",
            message=(
                f"No free or displaceable D room for "
                f"{self._doctor_code} on {self._day.value} {self._period.value}; "
                f"slot left without a room."
            ),
            rationale=rat.stages(
                self._need_line,
                self._rooms_line,
                self._victims_line,
                rat.decided(
                    "nothing left to try -- every D room was held by someone "
                    "who could not be displaced (not Partner/Salaried, on "
                    "leave, or already holding a role)"
                ),
            ),
        )

    def victim_not_relocatable(
        self, victim_pool: list, displaced_id: int, d_room_id: int,
    ) -> None:
        self._add(
            "no_single_session_room", related_doctor_id=displaced_id,
            room_id=d_room_id,
            message=(
                f"Could not relocate {code(self._context, displaced_id)} to free "
                f"{self._room(d_room_id)} for "
                f"{self._doctor_code} on {self._day.value} {self._period.value}; "
                f"slot left without a room."
            ),
            rationale=rat.stages(
                self._need_line,
                self._rooms_line,
                self._victims_line,
                f"{code(self._context, displaced_id)} was chosen as the victim "
                f"({_victim_decisive(self._context, self._counters, victim_pool, displaced_id)}).",
                rat.decided(
                    "abandoned -- no room on their preference list, and no free "
                    "C/W/SR room, was available to rehouse them, so the "
                    "displacement was rolled back rather than half-applied"
                ),
            ),
        )

    def displaced(
        self, victim_pool: list, displaced_id: int, d_room_id: int,
        new_room: int, tier: int,
    ) -> None:
        """Called *after* the moves and the room-move increment, as Pass 2
        has always logged it -- the decisive stage it names is therefore
        computed against the post-increment counter."""
        self._add(
            "displace_room", related_doctor_id=displaced_id,
            room_id=d_room_id, related_room_id=new_room,
            message=(
                f"Displaced {code(self._context, displaced_id)} from "
                f"{self._room(d_room_id)} to "
                f"{self._room(new_room)} to free the D room for "
                f"{self._doctor_code} on {self._day.value} {self._period.value} "
                f"(pass 2, selected on priority tier {tier}, tie broken on "
                f"weighted room-move score)."
            ),
            rationale=rat.stages(
                self._need_line,
                self._rooms_line,
                "No D room was free, so a victim was sought.",
                self._victims_line,
                rat.decided(
                    _victim_decisive(self._context, self._counters, victim_pool, displaced_id)
                ),
                f"{code(self._context, displaced_id)} was rehoused in "
                f"{self._room(new_room)} (first free room on their own "
                f"preference list, else the first free C/W/SR room) and their "
                f"room-move counter was incremented.",
            ),
        )


# ---------------------------------------------------------------------------
# Pass 3: Partner/Salaried fallback (no displacement)
# ---------------------------------------------------------------------------

class Pass3Narrator:
    """One Partner/Salaried doctor's fallback search. Construct before the
    assignment: the preference line has to show the rooms as free."""

    def __init__(
        self, context: GenerationContext, grid: RotaGrid, log: DecisionLog,
        gen_week: int, day: Day, period: Period, doctor_id: int,
    ) -> None:
        self._context = context
        self._log = log
        self._week = gen_week
        self._day = day
        self._period = period
        self._doctor_id = doctor_id
        self._doctor_code = code(context, doctor_id)
        preferred = context.preferred_rooms_by_doctor.get(doctor_id, ())
        self._preference_line = rat.listing(
            f"{self._doctor_code}'s preferred rooms, in their stated order",
            [
                room_state(context, grid, gen_week, day, period, rid)
                for rid in preferred
            ],
        )

    def _room(self, room_id: int) -> str:
        return self._context.room_by_id[room_id].code

    def _add(self, action: str, message: str, rationale: str | None, **fields) -> None:
        self._log.add(
            phase=PHASE, action=action, week=self._week, day=self._day,
            period=self._period, doctor_id=self._doctor_id, message=message,
            rationale=rationale, **fields,
        )

    def no_room(self) -> None:
        self._add(
            "no_partner_salaried_room",
            message=(
                f"No free room anywhere for {self._doctor_code} on {self._day.value} "
                f"{self._period.value}; slot remains unresolved."
            ),
            rationale=rat.stages(
                self._preference_line,
                "Nothing on that list was free, and pass 3 never displaces "
                "anyone, so the forced fallback (every room, by type priority "
                "D > C > W > SR) was tried next.",
                rat.decided(
                    "nothing left to try -- every room in the practice was "
                    "occupied this session"
                ),
            ),
        )

    def assigned(self, chosen: int, is_fallback: bool) -> None:
        if is_fallback:
            message = (
                f"Assigned fallback room {self._room(chosen)} to "
                f"{self._doctor_code} (pass 3, no preferred room free; forced into "
                f"first free room by type priority D > C > W > SR)."
            )
            rationale = rat.stages(
                self._preference_line,
                "Nothing on that list was free, and pass 3 never displaces anyone.",
                rat.decided(
                    f"forced fallback -- {self._room(chosen)} is the "
                    f"first free room by type priority D > C > W > SR (D rooms are "
                    f"included here because passes 1 and 2 have already taken every "
                    f"D room the Trainees/AHPs needed)"
                ),
            )
        else:
            message = (
                f"Assigned preferred room {self._room(chosen)} to "
                f"{self._doctor_code} (pass 3, first free room on preference list)."
            )
            rationale = rat.stages(
                self._preference_line,
                rat.decided(
                    f"{rat.PREFERENCE_ORDER} -- "
                    f"{self._room(chosen)} was the first free room on it"
                ),
            )
        self._add("assign_room", room_id=chosen, message=message, rationale=rationale)


__all__ = [
    "PHASE", "Pass1Narrator", "Pass2Narrator", "Pass3Narrator", "TIER_MEANINGS",
]