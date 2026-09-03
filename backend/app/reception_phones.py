"""Phones top-up selection for one generated reception day.

Answers exactly one question: after the front desk has been assigned, who
moves off `online_triage` and onto `phones`, for which half-hour slots, so
that as few hours as possible sit below `min_phones_for_hour`? The answer is
a list of contiguous chunks -- one person covering a run, rather than three
people covering a slot each -- and nothing else. The coverage rule itself is
not this module's business; it reads `min_phones_for_hour` and never argues
with it.

**The window is `RECEPTION_HOURS` filtered by the coverage rule, and it is
wider than front desk's.** `reception_front_desk` covers 8:00am-6:00pm
because the desk is not manned before opening or after close. Phones cover is
required for every slot `min_phones_for_hour` returns non-zero for, which
includes the closing 6:00-6:30 slot: twenty-one of the day's twenty-two
slots, only 7:30-8:00 exempt. `TOPUP_HOURS` is therefore *derived* from
`RECEPTION_HOURS` and the coverage rule at import, so a future change to
`PHONES_OPEN_HOUR` moves it automatically. This module never reads
`FRONT_DESK_HOURS`, and imports nothing from `reception_front_desk`.

**Greedy longest-chunk, knowingly suboptimal.** Front desk enumerates all
fifty legal partitions of a fixed window and returns the true optimum; this
problem does not have that shape. Demand is a per-hour *deficit vector* over
twenty-one slots where a deficit can be 2, deficit hours are not contiguous,
and chunks are a covering with multiplicity rather than a partition. So the
greedy pass can get it wrong: it can hand a long run to the only person who
could have covered a later gap, leaving that gap unfilled where a split would
have covered both. The recognisable symptom, so a future bug report is not
mistaken for a defect here: **a `phones_shortfall` at a late hour, with
somebody visibly on `phones` earlier in the day who could have covered it.**
That is this trade-off working as documented. The residual surfaces through
the existing `phones_shortfall` warning -- the same "nothing blocks, warnings
tell the truth" convention as the rest of reception. Min-cost flow or a DP
over slot states would be optimal and are a large step up in complexity;
revisit only if real days produce bad answers.

**Longest chunk first, with a one-slot tolerance band before fairness
decides.** Candidates are ranked on deficit slots covered, but *not*
lexicographically. A strict `(-deficit_slots, load, staff_id)` order would
make fairness vestigial: someone available 9:00-5:00 always beats someone
available 9:00-12:00 for a gap starting at 9:00 regardless of load, so the
same full-time triage person would take every top-up every day and a rising
phones ratio could never overcome the first key. Instead the best
deficit-slot count defines a shortlist -- every candidate within
`COVERAGE_TOLERANCE_SLOTS` of it -- and the lowest phones load wins from
there, `staff_id` breaking the final tie. Chunk quality still dominates,
because it decides the shortlist, but fairness can actually move the answer.
Same intent as the front-desk scorer's weighted `W_FAIR`, in the shape this
problem has. Ranking counts *deficit* slots, not total slots: bridged slots
are a convenience, not a goal, and must not inflate a candidate's rank.

**Bridging, up to one hour of it.** Deficits at 9:00 and 10:00 but not 9:30
give one person 9:00-10:30 rather than two 30-minute stints. At most
`MAX_BRIDGE_SLOTS` consecutive non-deficit slots are crossed, which stops a
bridge swallowing a whole afternoon of triage, and trailing bridged slots are
trimmed so a chunk always starts and ends on a real deficit slot. Bridged
slots are part of the chunk and **are written as `phones`**: they consume that
person's triage time and push those hours above the minimum. That is the cost
of contiguity and it is intended.

**Online triage is fully sacrificial.** There is no minimum triage headcount,
hard or soft. Phones is the only role in reception with a minimum-staffing
concept and introducing a second one for triage would be a new domain rule to
justify, document and edit; triage is stripped to zero if that is what the
phones minimum needs.

**The role filter is the whole availability rule.** Only `online_triage` rows
are candidates -- not `other`, not `admin`. A consequence worth stating so
nobody "fixes" it: there is no analogue of
`reception_front_desk._UNAVAILABLE_ROLES` here and none is needed, because
`lunch`, `not_working`, `cutteslowe` and `wolvercote` are excluded by the role
filter itself, as is anyone the desk has already taken (they are `front_desk`
by the time this runs).

**No minimum chunk length, deliberately.** Front desk has `MIN_BLOCK_SLOTS`
because a forty-minute stint on the desk is operationally silly. A lone
30-minute phones stint is a worse answer than a two-hour one but a better
answer than a shortfall, and the bridging rule exists to make short chunks
rare rather than to forbid them. This is a decision, not an oversight -- do
not add one.

**This module performs no writes and no queries.** It takes the loaded rota,
the ids on leave, and the counters aggregate, and returns blocks; the caller
applies them (setting `displaced_role`, per the invariant on
`ReceptionRotaSession`). Every tie-break ends in `staff_id`, so re-running
against unchanged data gives the same answer.
"""
from __future__ import annotations

from dataclasses import dataclass

from .models import ReceptionRota
from .models.enums import ReceptionRole
from .models.reception import RECEPTION_HOURS, min_phones_for_hour
from .reception_counters import RoleCounters

# At most this many consecutive non-deficit slots may be crossed to keep a
# chunk contiguous -- two slots is one hour.
MAX_BRIDGE_SLOTS = 2

# How far below the best deficit-slot count a candidate may be and still make
# the shortlist that fairness then decides.
COVERAGE_TOLERANCE_SLOTS = 1

HOURS_PER_SLOT = 0.5

# The slots this module may fill: every hour of the rota's own day for which
# the coverage rule asks for anybody at all. Derived, never written out as
# literals -- the window is defined by the coverage rule, not by this module.
TOPUP_HOURS = [hour for hour in RECEPTION_HOURS if min_phones_for_hour(hour) > 0]


@dataclass(frozen=True)
class PhonesBlock:
    """One contiguous run of slots and the staff member moved onto phones for
    it.

    `end_hour_exclusive` is the first hour *not* in the block, so a block
    ending at 6:30pm has `end_hour_exclusive == 18.5` and its last slot starts
    at 18.0. `slot_hours` is every start hour in the block -- including any
    bridged slot, which is written as `phones` like the rest -- which is what
    the caller rewrites rows for.
    """

    staff_id: int
    start_hour: float
    end_hour_exclusive: float
    slot_hours: tuple[float, ...]


def _phones_deficit(rota: ReceptionRota, staff_on_leave: set[int]) -> dict[float, int]:
    """How many more people each covered hour needs on phones.

    Staff on leave are excluded from the headcount -- the same exclusion
    `compute_coverage_issues` applies, since a slot held by someone later
    marked off is not covered. Hours already at or above the minimum score 0.
    """
    headcount: dict[float, int] = {hour: 0 for hour in TOPUP_HOURS}
    for session in rota.sessions:
        if session.role != ReceptionRole.PHONES:
            continue
        if session.staff_id in staff_on_leave:
            continue
        if session.hour in headcount:
            headcount[session.hour] += 1
    return {
        hour: max(0, min_phones_for_hour(hour) - count)
        for hour, count in headcount.items()
    }


def _triage_availability(
    rota: ReceptionRota, staff_on_leave: set[int]
) -> dict[int, set[float]]:
    """Which covered hours each staff member is on `online_triage` for.

    Row existence is the data, exactly as everywhere else in reception: an
    absent row is an absent person. The role filter is the whole rule -- see
    the module docstring on why there is no unavailable-roles set here.
    """
    covered = set(TOPUP_HOURS)
    availability: dict[int, set[float]] = {}
    for session in rota.sessions:
        if session.role != ReceptionRole.ONLINE_TRIAGE:
            continue
        if session.staff_id in staff_on_leave:
            continue
        if session.hour not in covered:
            continue
        availability.setdefault(session.staff_id, set()).add(session.hour)
    return availability


def _phones_load(counters: RoleCounters) -> dict[int, float]:
    """Each staff member's phones load as a proportion of time worked.

    A proportion, not a raw count: raw counts structurally favour part-timers,
    who always have fewer phones slots than someone in five days a week and
    would win every tie-break on every day they are in. A zero denominator --
    a new starter, or nobody generated in the window -- scores 0.0, i.e.
    lowest load and picked first, mirroring `reception_front_desk._fairness`
    and the counters page's "no data" rule.

    Near-identical to `_fairness` in the front-desk module, and copied rather
    than shared on purpose: two five-line functions that happen to agree today
    are cheaper to read than one parameterised one, and this module is
    deliberately independent of that one.
    """
    scores: dict[int, float] = {}
    for row in counters.staff:
        worked = row.hours_worked
        if worked <= 0:
            scores[row.staff_id] = 0.0
            continue
        phones_hours = row.role_slots.get(ReceptionRole.PHONES, 0) * HOURS_PER_SLOT
        scores[row.staff_id] = phones_hours / worked
    return scores


def _walk_chunk(
    start: float, hours_available: set[float], deficit: dict[float, int]
) -> tuple[float, ...]:
    """The chunk one candidate would cover starting at `start`.

    Walks forward slot by slot while the next slot is inside the window and in
    that person's availability. A deficit slot resets the bridge run; a
    non-deficit slot extends it, and the walk stops rather than taking a slot
    that would make the run longer than `MAX_BRIDGE_SLOTS`. Trailing
    non-deficit slots are then trimmed, so the chunk ends on a real deficit
    slot -- and since `start` itself always has a deficit, the result is never
    empty.
    """
    index = TOPUP_HOURS.index(start)
    taken: list[float] = [start]
    bridge_run = 0
    for hour in TOPUP_HOURS[index + 1:]:
        if hour not in hours_available:
            break
        if deficit.get(hour, 0) > 0:
            bridge_run = 0
        else:
            if bridge_run + 1 > MAX_BRIDGE_SLOTS:
                break
            bridge_run += 1
        taken.append(hour)
    while taken and deficit.get(taken[-1], 0) <= 0:
        taken.pop()
    return tuple(taken)


def select_phones_blocks(
    rota: ReceptionRota,
    staff_on_leave: set[int],
    counters: RoleCounters,
) -> list[PhonesBlock]:
    """The phones top-up chunks for this day, or `[]` if there is nothing to
    do.

    Called *after* the front-desk blocks have been applied, so it reads the
    post-desk world -- the desk deliberately displaces phones, and this step
    exists partly to repair the hole it just made.

    Returns `[]` when there is no deficit, when nobody is on triage, or when
    no deficit hour has a triage candidate. Never raises, never returns a
    partial or illegal chunk. Performs no writes: the caller applies the
    returned blocks.
    """
    deficit = _phones_deficit(rota, staff_on_leave)
    if not any(deficit.values()):
        return []

    availability = _triage_availability(rota, staff_on_leave)
    if not availability:
        return []

    load = _phones_load(counters)
    blocks: list[PhonesBlock] = []
    unfillable: set[float] = set()

    while True:
        target = next(
            (
                hour
                for hour in TOPUP_HOURS
                if deficit[hour] > 0 and hour not in unfillable
            ),
            None,
        )
        if target is None:
            return blocks

        chunks = {
            staff_id: _walk_chunk(target, hours, deficit)
            for staff_id, hours in availability.items()
            if target in hours
        }
        if not chunks:
            # Availability only ever shrinks, so an hour with no candidate now
            # can never gain one -- this hour is done, whatever its deficit.
            unfillable.add(target)
            continue

        covered = {
            staff_id: sum(1 for hour in chunk if deficit[hour] > 0)
            for staff_id, chunk in chunks.items()
        }
        best = max(covered.values())
        shortlist = [
            staff_id
            for staff_id, count in covered.items()
            if best - count <= COVERAGE_TOLERANCE_SLOTS
        ]
        chosen = min(shortlist, key=lambda staff_id: (load.get(staff_id, 0.0), staff_id))
        chunk = chunks[chosen]

        blocks.append(
            PhonesBlock(
                staff_id=chosen,
                start_hour=chunk[0],
                end_hour_exclusive=chunk[-1] + HOURS_PER_SLOT,
                slot_hours=chunk,
            )
        )
        for hour in chunk:
            deficit[hour] = max(0, deficit[hour] - 1)
            availability[chosen].discard(hour)
