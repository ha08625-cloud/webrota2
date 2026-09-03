"""Front desk block selection for one generated reception day.

Answers exactly one question: given a generated day, who mans the front desk,
and between which times? The answer is a partition of 8:00am-6:00pm into two
or three contiguous blocks at half-hour boundaries, each held by one staff
member who is in the building for every slot of it.

**This window is narrower than `RECEPTION_HOURS` on purpose.** The rota's own
day runs 7:30am-6:30pm (twenty-two slots); front desk cover is expected for
8:00am-6:00pm (twenty slots) and no longer. 7:30-8:00 and 6:00-6:30 are
deliberately uncovered -- the desk is not manned before opening or after
close -- so the two ranges are separate constants and this module never reads
`RECEPTION_HOURS`.

**Exhaustive enumeration, not a heuristic.** There are exactly fifty legal
partitions of the twenty slots (five two-block, forty-five three-block), and
at most a few hundred staff assignments per partition, so every legal solution
is generated and scored and the best is returned. The usual alternatives --
fixed changeover times, or a greedy longest-available-first pass -- are worse
answers at this size *and* not meaningfully simpler to write, so neither is
here.

**Nothing is a hard constraint that could leave the desk unmanned.** The
3-5 hour ideal block length is a score, not a rule, so an awkward day degrades
into a 2.5h + 5.5h split (ranked last, but produced) rather than failing.
Displacing a specialist role and pushing an hour below its phones minimum are
likewise penalties, not prohibitions: with a thin day a hard phones rule could
make the whole problem infeasible, and an unmanned desk is worse than a
coverage warning that already has a UI. The hard constraints are only those
whose violation would make the output *wrong* rather than undesirable: the
blocks must tile the window exactly, a holder must actually be present for
every slot they hold, and one person may not hold two *adjacent* blocks (that
is one long block wearing a hat). Holding two non-adjacent blocks -- a morning
and a late afternoon, with someone else in the middle -- is a normal real-world
outcome, so it is legal and merely penalised.

When no legal solution exists at all this returns an empty list. It never
invents a partial or illegal assignment; the caller emits `front_desk_gap`
warnings instead.

**This module performs no writes and no queries.** It takes the loaded rota,
the ids on leave, and the counters aggregate, and returns blocks; the router
applies them (setting `displaced_role`, per the invariant on
`ReceptionRotaSession`). That is the same separation as `reception_counters`
-- the rule is unit-testable without HTTP.

Fairness reads `compute_role_counters` and nothing else. Deliberately absent:
recency, and any notion of who held the morning block last time. The counter
window is 29-33 days, which is already the horizon over which rotation
self-corrects -- if someone has managed to avoid the desk for a few weeks it is
entirely reasonable for them to take it several days running, and that is what
the counter is for. Dropping both also keeps this module reading only the
aggregate and the target day, never re-deriving historical blocks from past
days' role tags (which, with no blocks table, would mean guessing).
"""
from __future__ import annotations

from dataclasses import dataclass
from itertools import product

from .models import ReceptionRota
from .models.enums import ReceptionRole
from .models.reception import min_phones_for_hour
from .reception_counters import RoleCounters

# The covered window: 8:00am-6:00pm as twenty half-hour slots. FRONT_DESK_HOURS
# is the start hour of each, so the last slot starts at 17.5 and ends at 18.0.
FRONT_DESK_FIRST_HOUR = 8.0
FRONT_DESK_LAST_HOUR = 17.5
_SLOT_COUNT = int(round((FRONT_DESK_LAST_HOUR - FRONT_DESK_FIRST_HOUR) / 0.5)) + 1
FRONT_DESK_HOURS = [FRONT_DESK_FIRST_HOUR + 0.5 * i for i in range(_SLOT_COUNT)]
FRONT_DESK_END_HOUR = FRONT_DESK_LAST_HOUR + 0.5

# Block length limits, in slots. 4-12 slots is 2-6 hours; 6-10 slots (3-5
# hours) is the ideal band, outside which the length penalty starts.
MIN_BLOCK_SLOTS = 4
MAX_BLOCK_SLOTS = 12
IDEAL_MIN_SLOTS = 6
IDEAL_MAX_SLOTS = 10

MIN_BLOCK_COUNT = 2
MAX_BLOCK_COUNT = 3

HOURS_PER_SLOT = 0.5

# Scoring weights. Lower total wins. Phones damage is intentionally the
# strongest per-unit signal: displacing phones is both the cheapest
# displacement and the one thing that creates a coverage shortfall, and the
# two criteria deliberately overlap on that case. If these are ever retuned,
# keep that relationship -- W_PHONES must dominate W_ROLE.
W_LEN = 1.0  # per hour outside the 3-5h ideal band
W_FAIR = 6.0  # x the holder's front_desk_hours / hours_worked over the window
W_PHONES = 2.0  # per hour newly pushed below its phones minimum
W_ROLE = 0.5  # per slot displacing a specialist role
W_REPEAT = 4.0  # once, if one person holds two (non-adjacent) blocks

# Roles that mean "not at the desk this slot". `lunch` and `not_working` are
# self-explanatory; `cutteslowe` and `wolvercote` are branch sites -- that
# person is not in this building at all. Note what is *not* here: an existing
# `front_desk` row counts as available, because it is a working slot and,
# after the router's reset step, a leftover manual front-desk tag must not make
# its holder unassignable.
_UNAVAILABLE_ROLES: frozenset[ReceptionRole] = frozenset({
    ReceptionRole.LUNCH,
    ReceptionRole.NOT_WORKING,
    ReceptionRole.CUTTESLOWE,
    ReceptionRole.WOLVERCOTE,
})

# Roles cheap enough to displace without penalty. Everything else is a
# specialist doing something only they are set up to do this slot.
_FREELY_DISPLACEABLE: frozenset[ReceptionRole] = frozenset({
    ReceptionRole.PHONES,
    ReceptionRole.OTHER,
})


@dataclass(frozen=True)
class FrontDeskBlock:
    """One contiguous run of slots and the staff member holding it.

    `end_hour_exclusive` is the first hour *not* in the block, so a block
    ending at 6pm has `end_hour_exclusive == 18.0` and its last slot starts at
    17.5. `slot_hours` is every start hour in the block, which is what the
    caller writes rows for.
    """

    staff_id: int
    start_hour: float
    end_hour_exclusive: float
    slot_hours: tuple[float, ...]


def enumerate_partitions() -> list[tuple[int, ...]]:
    """Every legal way to cut twenty slots into two or three contiguous blocks
    of 4-12 slots each: exactly fifty of them (five two-block, forty-five
    three-block). Returned as slot counts in left-to-right order.

    Worth knowing before retuning the weights: within the 3-5h ideal band
    there are only six legal three-block shapes (3+3+4, 3+4+3, 4+3+3,
    3+3.5+3.5, 3.5+3+3.5, 3.5+3.5+3) and exactly one two-block shape (5+5).
    Ten hours over three blocks forces a 3h20 average, so the length penalty
    fires on most three-block days rather than acting as a rare tie-break.
    """
    partitions: list[tuple[int, ...]] = []
    lengths = range(MIN_BLOCK_SLOTS, MAX_BLOCK_SLOTS + 1)
    for count in range(MIN_BLOCK_COUNT, MAX_BLOCK_COUNT + 1):
        for combo in product(lengths, repeat=count):
            if sum(combo) == _SLOT_COUNT:
                partitions.append(combo)
    return partitions


def _blocks_for(partition: tuple[int, ...]) -> list[tuple[float, ...]]:
    """A partition's slot hours, one tuple per block."""
    blocks: list[tuple[float, ...]] = []
    index = 0
    for length in partition:
        blocks.append(tuple(FRONT_DESK_HOURS[index:index + length]))
        index += length
    return blocks


def compute_availability(
    rota: ReceptionRota, staff_on_leave: set[int]
) -> dict[int, set[float]]:
    """Which of the covered hours each staff member is available for.

    Available at an hour means: they have a session row for it on this day,
    they are not on leave for the date, and that row's role is not one of
    `_UNAVAILABLE_ROLES`. An absent row is an absent person -- row existence is
    the data, exactly as everywhere else in reception.

    Lunch is what makes this problem tractable rather than what breaks it: a
    1pm lunch means that person cannot hold a block spanning 12:30-13:30, which
    naturally pushes a changeover onto the lunch boundary. Ragged finish times
    then only constrain the final block, and there is normally someone who
    stays to close.
    """
    covered = set(FRONT_DESK_HOURS)
    availability: dict[int, set[float]] = {}
    for session in rota.sessions:
        if session.staff_id in staff_on_leave:
            continue
        if session.hour not in covered:
            continue
        if session.role in _UNAVAILABLE_ROLES:
            continue
        availability.setdefault(session.staff_id, set()).add(session.hour)
    return availability


def _fairness(counters: RoleCounters) -> dict[int, float]:
    """Each staff member's front desk load as a proportion of time worked.

    A proportion, not a raw count: raw counts structurally favour part-timers
    (someone in two days a week always has fewer front-desk slots than someone
    in five, so they would win every tie-break on every day they are in). This
    is the same ratio `lib/receptionWeightedScore.ts` renders on the counters
    page, so the two surfaces agree on what "least front desk" means. A zero
    denominator -- a new starter, or nobody generated in the window -- scores
    0.0, i.e. lowest load and picked first, mirroring that file's "no data"
    rule.
    """
    scores: dict[int, float] = {}
    for row in counters.staff:
        worked = row.hours_worked
        if worked <= 0:
            scores[row.staff_id] = 0.0
            continue
        front_desk_hours = row.role_slots.get(ReceptionRole.FRONT_DESK, 0) * HOURS_PER_SLOT
        scores[row.staff_id] = front_desk_hours / worked
    return scores


def _phones_headcount(
    rota: ReceptionRota, staff_on_leave: set[int]
) -> dict[float, int]:
    """Phones headcount per hour *before* any assignment, excluding staff on
    leave -- the same exclusion `compute_coverage_issues` applies, since a slot
    held by someone later marked off is not covered."""
    counts: dict[float, int] = {hour: 0 for hour in FRONT_DESK_HOURS}
    for session in rota.sessions:
        if session.role != ReceptionRole.PHONES:
            continue
        if session.staff_id in staff_on_leave:
            continue
        if session.hour in counts:
            counts[session.hour] += 1
    return counts


def _length_penalty(slot_count: int) -> float:
    """Hours by which a block falls outside the 3-5h ideal band."""
    if slot_count < IDEAL_MIN_SLOTS:
        return (IDEAL_MIN_SLOTS - slot_count) * HOURS_PER_SLOT
    if slot_count > IDEAL_MAX_SLOTS:
        return (slot_count - IDEAL_MAX_SLOTS) * HOURS_PER_SLOT
    return 0.0


def _block_cost(
    staff_id: int,
    slot_hours: tuple[float, ...],
    roles: dict[tuple[int, float], ReceptionRole],
    phones_before: dict[float, int],
    fairness: dict[int, float],
) -> float:
    """One block's contribution to the solution score."""
    cost = W_LEN * _length_penalty(len(slot_hours))
    cost += W_FAIR * fairness.get(staff_id, 0.0)

    for hour in slot_hours:
        current = roles[(staff_id, hour)]
        if current not in _FREELY_DISPLACEABLE:
            cost += W_ROLE
        if current == ReceptionRole.PHONES:
            # Damage is measured against the pre-assignment headcount, so an
            # hour that was already short is not this block's fault -- only
            # hours the assignment *newly* pushes below the minimum count.
            before = phones_before[hour]
            required = min_phones_for_hour(hour)
            if before >= required and before - 1 < required:
                cost += W_PHONES * HOURS_PER_SLOT
    return cost


def select_front_desk_blocks(
    rota: ReceptionRota,
    staff_on_leave: set[int],
    counters: RoleCounters,
) -> list[FrontDeskBlock]:
    """The best legal front desk partition for this day, or `[]` if there is
    none.

    Every legal (partition, assignment) pair is scored per the weights above
    and the lowest total wins. Ties break on the solution's
    `(staff_id, start hour)` sequence, so enumeration is fully deterministic
    and re-running against unchanged data gives the same answer.

    Performs no writes: the caller applies the returned blocks.
    """
    availability = compute_availability(rota, staff_on_leave)
    if not availability:
        return []

    roles = {
        (session.staff_id, session.hour): session.role for session in rota.sessions
    }
    phones_before = _phones_headcount(rota, staff_on_leave)
    fairness = _fairness(counters)

    best_key: tuple[float, tuple[tuple[int, float], ...]] | None = None
    best_blocks: list[FrontDeskBlock] = []

    for partition in enumerate_partitions():
        block_hours = _blocks_for(partition)

        candidates: list[list[int]] = []
        for slot_hours in block_hours:
            needed = set(slot_hours)
            available = sorted(
                staff_id
                for staff_id, hours in availability.items()
                if needed <= hours
            )
            if not available:
                break
            candidates.append(available)
        if len(candidates) != len(block_hours):
            continue  # some block has nobody who can cover all of it

        # Per-block costs are independent of the other blocks (the blocks are
        # disjoint in slots), so they are computed once per (block, candidate)
        # pair rather than once per combination.
        costs = [
            {
                staff_id: _block_cost(
                    staff_id, slot_hours, roles, phones_before, fairness
                )
                for staff_id in block_candidates
            }
            for slot_hours, block_candidates in zip(block_hours, candidates)
        ]

        for holders in product(*candidates):
            if any(a == b for a, b in zip(holders, holders[1:])):
                continue  # adjacent blocks held by one person are one block
            score = sum(costs[i][staff_id] for i, staff_id in enumerate(holders))
            if len(set(holders)) < len(holders):
                score += W_REPEAT
            key = (
                round(score, 9),
                tuple(
                    (staff_id, slot_hours[0])
                    for staff_id, slot_hours in zip(holders, block_hours)
                ),
            )
            if best_key is None or key < best_key:
                best_key = key
                best_blocks = [
                    FrontDeskBlock(
                        staff_id=staff_id,
                        start_hour=slot_hours[0],
                        end_hour_exclusive=slot_hours[-1] + HOURS_PER_SLOT,
                        slot_hours=slot_hours,
                    )
                    for staff_id, slot_hours in zip(holders, block_hours)
                ]

    return best_blocks
