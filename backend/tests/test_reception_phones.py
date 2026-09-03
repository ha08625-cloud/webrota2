"""Unit tests for phones top-up selection.

`select_phones_blocks` performs no queries and no writes -- it takes a loaded
rota, the ids on leave, and a counters aggregate -- so these tests build plain
ORM objects in memory with no DB session at all, in the same style as
`test_reception_front_desk.py`.

**These assert shapes and ordering properties, never scores.** "One person
covers a contiguous run rather than three people covering a slot each", "the
lower phones load wins within the tolerance band" and "a three-slot gap is not
bridged" are the rules; `MAX_BRIDGE_SLOTS` and `COVERAGE_TOLERANCE_SLOTS` are
expected to be retuned.
"""
import datetime

from app.models import ReceptionRota, ReceptionRotaSession
from app.models.enums import ReceptionRole
from app.models.reception import RECEPTION_HOURS, min_phones_for_hour
from app.reception_counters import RoleCounters, StaffRoleCounters
from app.reception_phones import (
    MAX_BRIDGE_SLOTS,
    TOPUP_HOURS,
    select_phones_blocks,
)

DATE = datetime.date(2026, 8, 17)  # a Monday

# Triage candidates; A < B < C so tie-break order is readable. Filler staff
# sitting on phones to satisfy the minimum use ids from _FILLER_BASE up, well
# clear of these.
A, B, C = 1, 2, 3
_FILLER_BASE = 100


def _rota(*, deficits=None, triage=None, extra=None):
    """A day whose phones headcount is exactly `min_phones_for_hour` short by
    the amounts in `deficits` (hour -> shortfall), with `triage` (staff id ->
    hours) on `online_triage` and any `extra` rows appended verbatim.

    Every hour not named in `deficits` is fully covered by filler staff, so a
    test only has to say where the holes are.
    """
    deficits = deficits or {}
    sessions = []
    for hour in TOPUP_HOURS:
        needed = min_phones_for_hour(hour) - deficits.get(hour, 0)
        for index in range(needed):
            sessions.append(
                ReceptionRotaSession(
                    staff_id=_FILLER_BASE + index,
                    hour=hour,
                    role=ReceptionRole.PHONES,
                )
            )
    for staff_id, hours in (triage or {}).items():
        for hour in hours:
            sessions.append(
                ReceptionRotaSession(
                    staff_id=staff_id, hour=hour, role=ReceptionRole.ONLINE_TRIAGE
                )
            )
    sessions.extend(extra or [])
    rota = ReceptionRota(date=DATE)
    rota.sessions = sessions
    return rota


def _counters(phones_hours=None, hours_worked=None):
    """A counters aggregate carrying only what the load ratio reads.

    Any staff id not named scores 0.0 (no data -> lowest load), which is the
    default these tests rely on to hold fairness equal.
    """
    phones_hours = phones_hours or {}
    hours_worked = hours_worked or {}
    staff = [
        StaffRoleCounters(
            staff_id=staff_id,
            code=f"R{staff_id}",
            active=True,
            role_slots={role: 0 for role in ReceptionRole}
            | {ReceptionRole.PHONES: int(round(phones_hours.get(staff_id, 0) * 2))},
            hours_worked=hours_worked.get(staff_id, 0.0),
        )
        for staff_id in sorted(set(phones_hours) | set(hours_worked))
    ]
    return RoleCounters(
        from_date=DATE - datetime.timedelta(weeks=4),
        to_date=DATE,
        days_counted=20,
        staff=staff,
    )


def _shape(blocks):
    """(staff_id, start hour, end hour) per block -- what the assertions read."""
    return [(b.staff_id, b.start_hour, b.end_hour_exclusive) for b in blocks]


def _run(rota, on_leave=None, counters=None):
    return select_phones_blocks(rota, on_leave or set(), counters or _counters())


def test_no_deficit_anywhere_returns_nothing():
    rota = _rota(triage={A: TOPUP_HOURS})
    assert _run(rota) == []


def test_single_slot_deficit_is_filled_by_one_slot_block():
    """No minimum chunk length: a lone half-hour stint is a legal answer."""
    rota = _rota(deficits={10.0: 1}, triage={A: [10.0]})
    assert _shape(_run(rota)) == [(A, 10.0, 10.5)]


def test_contiguous_deficit_becomes_one_block_not_three():
    hours = [9.0, 9.5, 10.0]
    rota = _rota(deficits=dict.fromkeys(hours, 1), triage={A: hours})
    assert _shape(_run(rota)) == [(A, 9.0, 10.5)]


def test_contiguous_deficit_is_split_when_nobody_spans_it():
    rota = _rota(
        deficits={9.0: 1, 9.5: 1, 10.0: 1},
        triage={A: [9.0, 9.5], B: [10.0]},
    )
    blocks = _run(rota)
    assert _shape(blocks) == [(A, 9.0, 10.0), (B, 10.0, 10.5)]
    covered = {hour for block in blocks for hour in block.slot_hours}
    assert covered == {9.0, 9.5, 10.0}


def test_a_single_non_deficit_slot_is_bridged():
    rota = _rota(deficits={9.0: 1, 10.0: 1}, triage={A: [9.0, 9.5, 10.0]})
    blocks = _run(rota)
    assert _shape(blocks) == [(A, 9.0, 10.5)]
    assert blocks[0].slot_hours == (9.0, 9.5, 10.0)


def test_a_three_slot_gap_is_not_bridged():
    """Longer than `MAX_BRIDGE_SLOTS`, so the run stops and the trailing
    non-deficit slots are trimmed -- two blocks, neither ending on a bridge."""
    assert MAX_BRIDGE_SLOTS == 2
    hours = [9.0, 9.5, 10.0, 10.5, 11.0]
    rota = _rota(deficits={9.0: 1, 11.0: 1}, triage={A: hours})
    blocks = _run(rota)
    assert _shape(blocks) == [(A, 9.0, 9.5), (A, 11.0, 11.5)]


def test_deficit_of_two_takes_two_people_and_one_person_leaves_it_short():
    both = _rota(deficits={9.0: 2}, triage={A: [9.0], B: [9.0]})
    assert _shape(_run(both)) == [(A, 9.0, 9.5), (B, 9.0, 9.5)]

    alone = _rota(deficits={9.0: 2}, triage={A: [9.0]})
    assert _shape(_run(alone)) == [(A, 9.0, 9.5)]


def test_no_triage_at_the_deficit_hour_returns_nothing():
    rota = _rota(deficits={9.0: 1}, triage={A: [14.0]})
    assert _run(rota) == []


def test_quiet_hour_requirement_is_one_not_two():
    """One person on phones is a deficit at 16:30 and not at 17:00."""
    quiet = _rota(triage={A: [17.0]})
    assert _run(quiet) == []

    busy = _rota(deficits={16.5: 1}, triage={A: [16.5]})
    assert _shape(_run(busy)) == [(A, 16.5, 17.0)]


def test_window_covers_the_closing_slot_and_excludes_half_past_seven():
    assert TOPUP_HOURS[0] == 8.0
    assert TOPUP_HOURS[-1] == 18.0
    assert len(TOPUP_HOURS) == 21
    assert 7.5 in RECEPTION_HOURS and 7.5 not in TOPUP_HOURS

    rota = _rota(deficits={18.0: 1}, triage={A: [18.0]})
    assert _shape(_run(rota)) == [(A, 18.0, 18.5)]


def test_staff_on_leave_are_excluded_from_headcount_and_from_the_pool():
    # B holds the only phones row at 9:00 besides one filler, and A is the only
    # triage candidate. With B on leave the hour is short by one more.
    rota = _rota(
        deficits={9.0: 1},
        triage={A: [9.0], C: [9.0]},
        extra=[
            ReceptionRotaSession(staff_id=B, hour=9.0, role=ReceptionRole.PHONES)
        ],
    )
    # B counts, so the seeded shortfall is already filled: nothing to do.
    assert _run(rota) == []
    # With B on leave the shortfall is back, and C on leave cannot fill it.
    assert _shape(_run(rota, on_leave={B, C})) == [(A, 9.0, 9.5)]


def test_only_online_triage_rows_are_candidates():
    non_candidates = [
        ReceptionRole.LUNCH,
        ReceptionRole.NOT_WORKING,
        ReceptionRole.CUTTESLOWE,
        ReceptionRole.WOLVERCOTE,
        ReceptionRole.FRONT_DESK,
        ReceptionRole.OTHER,
        ReceptionRole.ADMIN,
    ]
    for role in non_candidates:
        rota = _rota(
            deficits={9.0: 1},
            extra=[ReceptionRotaSession(staff_id=A, hour=9.0, role=role)],
        )
        assert _run(rota) == [], role


def test_the_lower_phones_load_wins_all_else_equal():
    rota = _rota(deficits={9.0: 1}, triage={A: [9.0], B: [9.0]})
    counters = _counters(
        phones_hours={A: 10.0, B: 1.0}, hours_worked={A: 30.0, B: 30.0}
    )
    assert _shape(_run(rota, counters=counters)) == [(B, 9.0, 9.5)]

    # A zero denominator scores 0.0 -- lowest load, so A wins despite B having
    # a real (non-zero) ratio.
    no_data = _counters(phones_hours={B: 1.0}, hours_worked={B: 30.0})
    assert _shape(_run(rota, counters=no_data)) == [(A, 9.0, 9.5)]


def test_tolerance_band_lets_fairness_move_the_answer_by_one_slot():
    """A candidate one deficit slot short of the best still makes the
    shortlist; two slots short does not."""
    heavy = _counters(phones_hours={A: 15.0}, hours_worked={A: 30.0})
    hours = [9.0, 9.5, 10.0, 10.5]
    deficits = dict.fromkeys(hours, 1)

    # A covers all four, B covers three: B is within the band and lighter.
    within = _rota(deficits=deficits, triage={A: hours, B: hours[:3]})
    assert _run(within, counters=heavy)[0].staff_id == B

    # B now covers only two -- outside the band, so chunk quality wins.
    outside = _rota(deficits=deficits, triage={A: hours, B: hours[:2]})
    assert _run(outside, counters=heavy)[0].staff_id == A


def test_ties_resolve_on_the_lower_staff_id_and_runs_are_deterministic():
    rota = _rota(deficits={9.0: 1}, triage={B: [9.0], A: [9.0]})
    assert _shape(_run(rota)) == [(A, 9.0, 9.5)]
    assert _shape(_run(rota)) == _shape(_run(rota))


def test_nobody_is_assigned_two_blocks_overlapping_the_same_hour():
    """A deficit of 2 across a run with only one candidate at the second
    person's slots: the chunk is emitted once and its hours leave that
    candidate's availability."""
    hours = [9.0, 9.5, 10.0]
    rota = _rota(deficits=dict.fromkeys(hours, 2), triage={A: hours, B: hours})
    blocks = _run(rota)
    per_staff: dict[int, list[float]] = {}
    for block in blocks:
        per_staff.setdefault(block.staff_id, []).extend(block.slot_hours)
    for staff_id, assigned in per_staff.items():
        assert len(assigned) == len(set(assigned)), staff_id
