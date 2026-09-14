"""Decision-log narration for Phase 4 (pre-planned duty rooms).

Phase 4 has to justify two quite different things to a reader of the
generation log: why the duty doctor ended up in the D room they did (and
who was evicted to make it happen), and why the second pass could or could
not consolidate them into one room for the whole day. Both accounts are
built here so `phase4.py` reads as the eviction algorithm rather than as
an essay with assignments in it.

`DutyRoomNarrator` is an object rather than a set of functions because it
captures the state of the world at the point it is constructed -- the D
room states as the search faced them -- and accumulates the search's dead
ends as they happen. By the time an entry is written the grid has moved
and the evictee's room-move counter has been incremented, so lines built
lazily would describe the wrong world.

Two methods, `preferred_room_eviction` and `sweep_eviction`, *return* a
rationale rather than writing an entry: the eviction entry itself is
written later by `_evict_and_place`, once it knows whether the evictee
found a new room. That split is Phase 4's, not this module's.
"""
from __future__ import annotations

from datetime import date

from ...models.enums import Day, Period
from .. import rationale as rat
from ..datatypes import CounterState, DecisionLog, GenerationContext, RotaGrid
from ._shared import code, is_room_free_all_day, room_move_rank, room_move_score_text

# Owned here rather than in `phase4.py` so the narrators can stamp it
# without importing their caller; the phase imports it back from here.
PHASE = "phase4"


def _d_room_states(
    context: GenerationContext, grid: RotaGrid,
    gen_week: int, day: Day, period: Period, d_room_ids_desc: list[int],
) -> list[str]:
    """One line per D room: who holds it this period, and -- when free --
    whether it is also free in the other period, which is what sweep pass A
    is looking for."""
    states = []
    for room_id in d_room_ids_desc:
        room_code = context.room_by_id[room_id].code
        occupant_id = grid.get_room_occupant(gen_week, day, period, room_id)
        if occupant_id is not None:
            states.append(f"{room_code}: held by {code(context, occupant_id)}")
        elif is_room_free_all_day(grid, gen_week, day, room_id):
            states.append(f"{room_code}: free, both periods")
        else:
            states.append(f"{room_code}: free this period only")
    return states


class DutyRoomNarrator:
    """One duty row's room search. Construct before touching the grid."""

    def __init__(
        self, context: GenerationContext, grid: RotaGrid, counters: CounterState,
        log: DecisionLog, doctor_id: int, doctor_code: str,
        gen_week: int, day: Day, period: Period, date_: date,
        d_room_ids_desc: list[int],
    ) -> None:
        self._context = context
        self._counters = counters
        self._log = log
        self._doctor_id = doctor_id
        self._code = doctor_code
        self._week = gen_week
        self._day = day
        self._period = period
        self._date = date_
        # Snapshot of what the search is working with, shared by every entry
        # below so each one says which rooms were available at the time.
        self._rooms_line = rat.listing(
            "D rooms at this session (code descending, the sweep order)",
            _d_room_states(context, grid, gen_week, day, period, d_room_ids_desc),
        )
        self._pref_line: str | None = None
        self._tried: list[str] = []

    # -- helpers -----------------------------------------------------------

    def _room(self, room_id: int) -> str:
        return self._context.room_by_id[room_id].code

    @property
    def duty_code(self) -> str:
        """The duty doctor's code -- also needed by the `ValidationIssue`
        `_evict_and_place` raises alongside its log entry."""
        return self._code

    @property
    def when(self) -> str:
        """`"2026-01-05 am"` -- this duty session, as every entry names it."""
        return f"{self._date.isoformat()} {self._period.value}"

    @property
    def _when(self) -> str:
        return self.when

    @property
    def _tried_line(self) -> str | None:
        return rat.listing("Rejected before the sweep", self._tried) if self._tried else None

    def _add(self, action: str, message: str, rationale: str | None, **fields) -> None:
        self._log.add(
            phase=PHASE, action=action, week=self._week, day=self._day,
            period=self._period, doctor_id=self._doctor_id, message=message,
            rationale=rationale, **fields,
        )

    # -- capture points ----------------------------------------------------

    def note_preferred(self, preferred_d_room: int | None) -> None:
        self._pref_line = (
            f"{self._code}'s first D room on their preference list: "
            f"{self._room(preferred_d_room)}"
            if preferred_d_room is not None
            else f"{self._code} has no D room on their preference list, so the sweep runs first"
        )

    def note_preferred_blocked(self, room_id: int, occupant_id: int, why: str) -> None:
        """Their preferred D room is held by someone protected -- record it
        as a dead end before falling through to the sweep."""
        self._tried.append(
            f"preferred D room {self._room(room_id)}: held by "
            f"{code(self._context, occupant_id)}, {why}"
        )

    # -- outcomes that need no eviction ------------------------------------

    def already_in_d_room(self, room_id: int) -> None:
        self._add(
            "room_already_assigned", room_id=room_id,
            message=(
                f"{self._code} already holds D room {self._room(room_id)} for "
                f"{self._when}; duty room requirement already satisfied."
            ),
            rationale=rat.stages(
                self._rooms_line,
                rat.decided(
                    f"no search run -- {self._code} already held D room "
                    f"{self._room(room_id)}, which satisfies the duty requirement"
                ),
            ),
        )

    def preferred_room_free(self, room_id: int, moved_own_room: bool) -> None:
        if moved_own_room:
            message = (
                f"Moved {self._code} out of their own pre-assigned room and "
                f"into preferred D room {self._room(room_id)} for duty on "
                f"{self._when}."
            )
        else:
            message = (
                f"Assigned preferred D room {self._room(room_id)} to {self._code} "
                f"for duty on {self._when}."
            )
        self._add(
            "assign_room", room_id=room_id, message=message,
            rationale=rat.stages(
                self._rooms_line,
                self._pref_line,
                rat.decided(
                    f"{rat.PREFERENCE_ORDER} -- their preferred D room "
                    f"{self._room(room_id)} was free, so "
                    f"no sweep or eviction was needed"
                ),
            ),
        )

    def sweep_all_day_room(self, room_id: int) -> None:
        self._add(
            "assign_room", room_id=room_id,
            message=(
                f"Assigned free D room {self._room(room_id)} "
                f"to {self._code} for duty on {self._when} "
                f"(fallback sweep, first room free for both periods that "
                f"day, code descending)."
            ),
            rationale=rat.stages(
                self._rooms_line,
                self._pref_line,
                self._tried_line,
                rat.decided(
                    f"fallback sweep pass A -- "
                    f"{self._room(room_id)} is the highest-coded D "
                    f"room free in both periods, preferred over a period-only room so "
                    f"the consolidation pass has nothing to fix"
                ),
            ),
        )

    def sweep_period_room(self, room_id: int) -> None:
        self._add(
            "assign_room", room_id=room_id,
            message=(
                f"Assigned free D room {self._room(room_id)} "
                f"to {self._code} for duty on {self._when} "
                f"(fallback sweep, first room free this period only, code "
                f"descending; no room was free for both periods)."
            ),
            rationale=rat.stages(
                self._rooms_line,
                self._pref_line,
                self._tried_line,
                "Sweep pass A found no D room free in both periods of the day.",
                rat.decided(
                    f"fallback sweep pass B -- "
                    f"{self._room(room_id)} is the highest-coded D room "
                    f"free in this period"
                ),
            ),
        )

    def unresolved(self) -> None:
        self._add(
            "duty_room_unresolved",
            message=(
                f"No D room could be found or freed for duty doctor {self._code} "
                f"on {self._when}."
            ),
            rationale=rat.stages(
                self._rooms_line,
                self._pref_line,
                self._tried_line,
                "Neither sweep pass found a free D room, and no D room was held by a "
                "Salaried doctor who was role-free and not on leave, so there was "
                "nobody the sweep was allowed to evict.",
                rat.decided("nothing left to try -- the duty role stands without a D room"),
            ),
        )

    # -- eviction: the reason, then the outcome ----------------------------

    def preferred_room_eviction(self, occupant_id: int, room_id: int) -> str:
        """Why the preferred D room was taken from its occupant. Returned,
        not logged: `_evict_and_place` writes the entry once it knows where
        the occupant ended up."""
        return rat.stages(
            self._rooms_line,
            self._pref_line,
            f"It is held by {code(self._context, occupant_id)}, who is not "
            f"protected (not Partner/AHP and holds no role this session).",
            rat.decided(
                f"{rat.PREFERENCE_ORDER} -- the preferred D room was taken "
                f"by an evictable occupant, so it was taken from them rather "
                f"than falling through to the sweep"
            ),
        )

    def sweep_eviction(
        self, sweep_candidates: list[tuple[int, int]], evictee_id: int,
    ) -> str:
        """Why the sweep picked this evictee out of the Salaried field.
        Returned, not logged, for the same reason as above. Must be called
        before the evictee's room-move counter is incremented -- the scores
        it quotes are read live."""
        scores_line = rat.listing(
            "Evictable Salaried D-room occupants, by weighted room-move counter",
            [
                f"{code(self._context, cand_id)} in "
                f"{self._room(room)} "
                f"({room_move_score_text(self._context, self._counters, cand_id)})"
                for cand_id, room in sweep_candidates
            ],
        )
        best_score = room_move_rank(self._context, self._counters, evictee_id)[0]
        tied = [
            c for c in sweep_candidates
            if room_move_rank(self._context, self._counters, c[0])[0] == best_score
        ]
        decisive = (
            f"{rat.ALPHABETICAL} -- {code(self._context, evictee_id)}, all tied on a "
            f"weighted room-move score of {rat.fmt(best_score)}"
            if len(tied) > 1 else
            f"{rat.WEIGHTED_COUNTER} -- {code(self._context, evictee_id)} has the lowest "
            f"weighted room-move score, {rat.fmt(best_score)}, so is the least "
            f"disrupted by another move"
        )
        return rat.stages(
            self._rooms_line,
            self._pref_line,
            self._tried_line,
            "No D room was free in either sweep pass, so an occupant had to be "
            "evicted. Trainees and Locums are never sweep victims, so only "
            "Salaried occupants with no role and not on leave were considered.",
            scores_line,
            rat.decided(decisive),
        )

    def evicted_and_rehoused(
        self, evictee_id: int, evictee_code: str, d_room_id: int, new_room: int,
        stage_desc: str, reason: str | None,
    ) -> None:
        self._add(
            "displace_room", related_doctor_id=evictee_id,
            room_id=d_room_id, related_room_id=new_room,
            message=(
                f"Displaced {evictee_code} from {self._room(d_room_id)} to "
                f"{self._room(new_room)} to room duty doctor "
                f"{self._code} on {self._when} ({stage_desc})."
            ),
            rationale=rat.stages(
                reason,
                f"{evictee_code} was rehoused in "
                f"{self._room(new_room)} and their room-move counter "
                f"was incremented.",
            ),
        )

    def evicted_without_room(
        self, evictee_id: int, evictee_code: str, d_room_id: int,
        stage_desc: str, reason: str | None,
    ) -> None:
        self._add(
            "displace_room", related_doctor_id=evictee_id,
            room_id=d_room_id, related_room_id=None,
            message=(
                f"Displaced {evictee_code} from {self._room(d_room_id)} to room duty "
                f"doctor {self._code} on {self._when} "
                f"({stage_desc}); {evictee_code} could not be relocated."
            ),
            rationale=rat.stages(
                reason,
                f"{evictee_code}'s room-move counter was still incremented -- it "
                f"records the disruption, not the destination -- but no free room "
                f"was found for them on their preference list or in the fallback "
                f"pool, so they are left without a room.",
            ),
        )


# ---------------------------------------------------------------------------
# Second pass: same-day room consolidation
# ---------------------------------------------------------------------------

class ConsolidationNarrator:
    """One duty row's consolidation attempt. Every entry opens with the same
    statement of the problem, so it is built once here."""

    def __init__(
        self, context: GenerationContext, log: DecisionLog, doctor_id: int,
        doctor_code: str, gen_week: int, day: Day, period: Period,
        other_period: Period, date_: date, duty_type, duty_room,
    ) -> None:
        self._context = context
        self._log = log
        self._doctor_id = doctor_id
        self._code = doctor_code
        self._week = gen_week
        self._day = day
        self._other_period = other_period
        self._date = date_
        self._duty_room = duty_room
        self._problem_line = (
            f"{doctor_code} holds D room {duty_room.code} for their "
            f"{duty_type.value} duty in {period.value} but a different room "
            f"in {other_period.value}."
        )
        self._duty_type = duty_type

    @property
    def _when(self) -> str:
        return f"{self._date.isoformat()} {self._other_period.value}"

    def _add(self, action: str, message: str, rationale: str | None, **fields) -> None:
        self._log.add(
            phase=PHASE, action=action, week=self._week, day=self._day,
            period=self._other_period, doctor_id=self._doctor_id, message=message,
            rationale=rationale, **fields,
        )

    def moved_into_free_room(self) -> None:
        self._add(
            "consolidate_room", room_id=self._duty_room.id,
            message=(
                f"Moved {self._code} into {self._duty_room.code} for "
                f"{self._when} to match their "
                f"{self._duty_type.value} duty room and avoid a mid-day room "
                f"change; the room was already free."
            ),
            rationale=rat.stages(
                self._problem_line,
                f"{self._duty_room.code} is unoccupied in {self._other_period.value}.",
                rat.decided(
                    "same-day consolidation with nobody to bump -- the duty "
                    "doctor's own move, so no room-move counter is touched"
                ),
            ),
        )

    def blocked_by_duty_occupant(self, occupant_id: int, occupant_code: str, role) -> None:
        self._add(
            "consolidate_room_skipped", related_doctor_id=occupant_id,
            room_id=self._duty_room.id,
            message=(
                f"Could not consolidate {self._code} into {self._duty_room.code} for "
                f"{self._when}: the room is "
                f"held by {occupant_code}, who is also on duty that "
                f"session."
            ),
            rationale=rat.stages(
                self._problem_line,
                f"{self._duty_room.code} is held in {self._other_period.value} by "
                f"{occupant_code}, who is on "
                f"{role.value} that session.",
                rat.decided(
                    "consolidation abandoned -- a duty doctor is never bumped "
                    "for another doctor's consolidation, and consolidation is "
                    "opportunistic, so both doctors stay where the first pass "
                    "put them"
                ),
            ),
        )

    def occupant_has_nowhere_to_go(self, occupant_id: int, occupant_code: str) -> None:
        self._add(
            "consolidate_room_skipped", related_doctor_id=occupant_id,
            room_id=self._duty_room.id,
            message=(
                f"Could not consolidate {self._code} into {self._duty_room.code} for "
                f"{self._when}: the room is "
                f"held by {occupant_code} and no other D room was free "
                f"to move them into."
            ),
            rationale=rat.stages(
                self._problem_line,
                f"{self._duty_room.code} is held in {self._other_period.value} by "
                f"{occupant_code}, who could be bumped, but no D room on their "
                f"preference list or anywhere else was free that session (a "
                f"bumped occupant is only ever moved to another D room here).",
                rat.decided(
                    "consolidation abandoned -- it is opportunistic, so both "
                    "doctors stay where the first pass put them"
                ),
            ),
        )

    def moved_with_bump(
        self, occupant_id: int, occupant_code: str, bump_room: int,
    ) -> None:
        bump_code = self._context.room_by_id[bump_room].code
        self._add(
            "consolidate_room", related_doctor_id=occupant_id,
            room_id=self._duty_room.id, related_room_id=bump_room,
            message=(
                f"Moved {self._code} into {self._duty_room.code} for "
                f"{self._when} to match their "
                f"{self._duty_type.value} duty room, bumping {occupant_code} to "
                f"{bump_code} to make room."
            ),
            rationale=rat.stages(
                self._problem_line,
                f"{self._duty_room.code} is held in {self._other_period.value} by "
                f"{occupant_code}, who is not on duty that session and so may be "
                f"bumped; {bump_code} was the first D room "
                f"free for them.",
                rat.decided(
                    "same-day consolidation with a bump -- neither doctor's "
                    "room-move counter is touched, since that counter records "
                    "displacement by someone else's duty requirement, not tidying "
                    "up a day"
                ),
            ),
        )


def duty_applied(
    log: DecisionLog, gen_week: int, day: Day, period: Period, doctor_id: int,
    doctor_code: str, date_: date, duty_type,
) -> None:
    log.add(
        phase=PHASE, action="assign_duty",
        week=gen_week, day=day, period=period, doctor_id=doctor_id,
        message=(
            f"Applied {duty_type.value} duty to {doctor_code} on "
            f"{date_.isoformat()} {period.value} (pre-planned)."
        ),
        rationale=rat.stages(
            f"Duty roster names {doctor_code} as {duty_type.value} duty for "
            f"{date_.isoformat()} {period.value}.",
            rat.decided(
                "no selection was made -- this phase never chooses who is on "
                "duty, and no priority tier or counter was consulted; only the "
                "room below was decided here"
            ),
        ),
    )


def wfh_abandoned(
    log: DecisionLog, gen_week: int, day: Day, period: Period, doctor_id: int,
    doctor_code: str, date_: date,
) -> None:
    log.add(
        phase=PHASE, action="wfh_abandoned",
        week=gen_week, day=day, period=period, doctor_id=doctor_id,
        message=(
            f"{doctor_code} was scheduled to work from home on "
            f"{date_.isoformat()} {period.value}; duty overrides this "
            f"and the doctor is rostered on-site instead."
        ),
    )


__all__ = [
    "PHASE", "ConsolidationNarrator", "DutyRoomNarrator",
    "duty_applied", "wfh_abandoned",
]
