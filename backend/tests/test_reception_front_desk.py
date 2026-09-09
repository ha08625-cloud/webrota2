"""Unit tests for front desk block selection.

`select_front_desk_blocks` performs no queries and no writes -- it takes a
loaded rota, the ids on leave, and a counters aggregate -- so these tests build
plain ORM objects in memory with no DB session at all.

**These assert ordering properties, never exact scores.** "Prefers the person
with the lower front-desk proportion, all else equal" and "prefers 5+5 over
4+6" are the rules; the weights that implement them are expected to be
retuned, and a suite pinned to floats would break on every tweak.
"""
import datetime

import pytest

from app.models import ReceptionRota, ReceptionRotaSession
from app.models.enums import ReceptionRole
from app.reception_counters import RoleCounters, StaffRoleCounters
from app.reception_front_desk import (
    FRONT_DESK_HOURS,
    MAX_BLOCK_SLOTS,
    MIN_BLOCK_SLOTS,
    compute_availability,
    enumerate_partitions,
    select_front_desk_blocks,
)

DATE = datetime.date(2026, 8, 17)  # a Monday

# Staff ids used throughout; A < B < C < D so tie-break order is readable.
A, B, C, D = 1, 2, 3, 4


def _hour(index: int) -> float:
    """The start hour of covered slot `index` (0 -> 8:00, 19 -> 17:30)."""
    return FRONT_DESK_HOURS[index]


def _rota(*, sessions):
    rota = ReceptionRota(date=DATE)
    rota.sessions = list(sessions)
    return rota


def _rows(staff_id, indices, role=ReceptionRole.OTHER, overrides=None):
    """Session rows for `staff_id` on the given covered-slot indices.

    `overrides` maps a slot index to a different role, which is how these
    tests place a lunch slot or a branch-site slot inside an otherwise
    available run.
    """
    overrides = overrides or {}
    return [
        ReceptionRotaSession(
            staff_id=staff_id, hour=_hour(i), role=overrides.get(i, role)
        )
        for i in indices
    ]


def _counters(front_desk_hours=None, hours_worked=None):
    """A counters aggregate carrying only what fairness reads.

    Any staff id not named scores 0.0 (no data -> lowest load), which is the
    default these tests rely on to hold fairness equal.
    """
    front_desk_hours = front_desk_hours or {}
    hours_worked = hours_worked or {}
    staff = [
        StaffRoleCounters(
            staff_id=staff_id,
            code=f"R{staff_id}",
            active=True,
            role_slots={
                role: 0 for role in ReceptionRole
            } | {ReceptionRole.FRONT_DESK: int(round(front_desk_hours.get(staff_id, 0) * 2))},
            hours_worked=hours_worked.get(staff_id, 0.0),
        )
        for staff_id in sorted(set(front_desk_hours) | set(hours_worked))
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


# --- partitions ------------------------------------------------------------


def test_exactly_fifty_legal_partitions():
    partitions = enumerate_partitions()
    assert len(partitions) == 50
    assert sum(1 for p in partitions if len(p) == 2) == 5
    assert sum(1 for p in partitions if len(p) == 3) == 45


def test_every_partition_tiles_the_window_within_the_length_limits():
    for partition in enumerate_partitions():
        assert sum(partition) == len(FRONT_DESK_HOURS) == 20
        assert all(MIN_BLOCK_SLOTS <= length <= MAX_BLOCK_SLOTS for length in partition)


# --- availability ----------------------------------------------------------


def test_availability_excludes_lunch_branch_sites_and_absent_rows():
    rota = _rota(sessions=_rows(
        A,
        range(0, 13),
        overrides={
            4: ReceptionRole.LUNCH,
            5: ReceptionRole.NOT_WORKING,
            6: ReceptionRole.CUTTESLOWE,
            7: ReceptionRole.WOLVERCOTE,
            8: ReceptionRole.REGISTRATIONS,
            9: ReceptionRole.ONLINE_TRIAGE,
        },
    ))
    available = compute_availability(rota, staff_on_leave=set())
    # 13 rows, six unavailable roles, and slots 13-19 have no row at all.
    assert available[A] == {_hour(i) for i in list(range(0, 4)) + list(range(10, 13))}


def test_availability_excludes_staff_on_leave_entirely():
    rota = _rota(sessions=_rows(A, range(20)) + _rows(B, range(20)))
    available = compute_availability(rota, staff_on_leave={B})
    assert set(available) == {A}


def test_an_existing_front_desk_row_still_counts_as_available():
    """After the router's reset step a leftover manual `front_desk` tag must
    not make its holder unassignable -- it is a working slot like any other."""
    rota = _rota(sessions=_rows(A, range(20), role=ReceptionRole.FRONT_DESK))
    available = compute_availability(rota, staff_on_leave=set())
    assert available[A] == set(FRONT_DESK_HOURS)


# --- no legal solution -----------------------------------------------------


def test_a_day_only_one_person_can_cover_returns_no_blocks():
    """One person available all day cannot be the answer: two adjacent blocks
    held by one person are one block wearing a hat, and are rejected."""
    rota = _rota(sessions=_rows(A, range(20)))
    assert select_front_desk_blocks(rota, set(), _counters()) == []


def test_an_uncoverable_stretch_returns_no_blocks_rather_than_raising():
    # Nobody at all after 3pm, so the window cannot be tiled.
    rota = _rota(sessions=_rows(A, range(0, 14)) + _rows(B, range(0, 14)))
    assert select_front_desk_blocks(rota, set(), _counters()) == []


def test_an_empty_day_returns_no_blocks():
    assert select_front_desk_blocks(_rota(sessions=[]), set(), _counters()) == []


# --- ordering properties ---------------------------------------------------


def test_prefers_the_balanced_split_over_a_lopsided_one():
    """A available for the first twelve slots, B for the last twelve, so the
    changeover can legally fall anywhere from 12:00 to 14:00. The 5h+5h cut
    should win over 4h+6h or 6h+4h."""
    rota = _rota(sessions=_rows(A, range(0, 12)) + _rows(B, range(8, 20)))
    blocks = select_front_desk_blocks(rota, set(), _counters())
    assert _shape(blocks) == [(A, 8.0, 13.0), (B, 13.0, 18.0)]


def test_prefers_the_lower_front_desk_proportion_all_else_equal():
    """Only one partition is legal (A must hold the morning, B or C the
    afternoon), so the choice is purely the fairness comparison. C has done
    proportionally less front desk than B."""
    rota = _rota(
        sessions=_rows(A, range(0, 10)) + _rows(B, range(10, 20)) + _rows(C, range(10, 20))
    )
    counters = _counters(
        front_desk_hours={B: 10.0, C: 2.0},
        hours_worked={B: 100.0, C: 100.0},
    )
    assert _shape(select_front_desk_blocks(rota, set(), counters)) == [
        (A, 8.0, 13.0),
        (C, 13.0, 18.0),
    ]


def test_proportion_not_raw_count_so_a_part_timer_does_not_always_win():
    """B has done twice the front-desk *hours* of C but works five times the
    hours, so B is the less loaded of the two and should be picked."""
    rota = _rota(
        sessions=_rows(A, range(0, 10)) + _rows(B, range(10, 20)) + _rows(C, range(10, 20))
    )
    counters = _counters(
        front_desk_hours={B: 10.0, C: 5.0},
        hours_worked={B: 200.0, C: 40.0},
    )
    assert _shape(select_front_desk_blocks(rota, set(), counters))[1][0] == B


def test_avoids_creating_a_phones_shortfall_when_an_equal_alternative_exists():
    """B is one of exactly two people on phones in the afternoon, so taking B
    to the desk pushes those hours below the minimum. C is on `other` and
    costs nothing, and is otherwise identical."""
    rota = _rota(
        sessions=(
            _rows(A, range(0, 10))
            + _rows(B, range(10, 20), role=ReceptionRole.PHONES)
            + _rows(C, range(10, 20), role=ReceptionRole.OTHER)
            # D is the second phones body but is only in until 4pm, so D is
            # never a candidate for the ten-slot afternoon block.
            + _rows(D, range(10, 16), role=ReceptionRole.PHONES)
        )
    )
    assert _shape(select_front_desk_blocks(rota, set(), _counters()))[1][0] == C


def test_prefers_a_freely_displaceable_role_over_a_specialist_one():
    rota = _rota(
        sessions=(
            _rows(A, range(0, 10))
            + _rows(B, range(10, 20), role=ReceptionRole.PRESCRIPTIONS)
            + _rows(C, range(10, 20), role=ReceptionRole.OTHER)
        )
    )
    assert _shape(select_front_desk_blocks(rota, set(), _counters()))[1][0] == C


def test_one_person_may_hold_two_non_adjacent_blocks():
    """A opens and closes with B covering the middle -- a normal outcome, and
    the only legal one here. Rejecting it outright would leave the desk
    unmanned, which is worse."""
    rota = _rota(sessions=_rows(A, range(20)) + _rows(B, range(6, 14)))
    blocks = select_front_desk_blocks(rota, set(), _counters())
    # Which of the legal cuts wins is a scoring detail; that A holds the two
    # outer blocks and B the middle one is the property under test.
    assert [b.staff_id for b in blocks] == [A, B, A]
    assert blocks[0].start_hour == 8.0 and blocks[-1].end_hour_exclusive == 18.0


def test_but_a_third_person_is_preferred_over_repeating_the_same_holder():
    """Same shape as above, plus C available for the closing block only: the
    repeat penalty means C takes it rather than A coming back."""
    rota = _rota(
        sessions=_rows(A, range(20)) + _rows(B, range(6, 14)) + _rows(C, range(14, 20))
    )
    assert _shape(select_front_desk_blocks(rota, set(), _counters())) == [
        (A, 8.0, 11.0),
        (B, 11.0, 15.0),
        (C, 15.0, 18.0),
    ]


def test_staff_on_leave_are_never_assigned():
    rota = _rota(
        sessions=_rows(A, range(0, 10)) + _rows(B, range(10, 20)) + _rows(C, range(10, 20))
    )
    blocks = select_front_desk_blocks(rota, staff_on_leave={C}, counters=_counters())
    assert _shape(blocks) == [(A, 8.0, 13.0), (B, 13.0, 18.0)]


def test_blocks_tile_the_window_exactly():
    rota = _rota(sessions=_rows(A, range(20)) + _rows(B, range(20)) + _rows(C, range(20)))
    blocks = select_front_desk_blocks(rota, set(), _counters())
    assert blocks[0].start_hour == 8.0
    assert blocks[-1].end_hour_exclusive == 18.0
    for earlier, later in zip(blocks, blocks[1:]):
        assert earlier.end_hour_exclusive == later.start_hour
    assert [h for b in blocks for h in b.slot_hours] == FRONT_DESK_HOURS


@pytest.mark.parametrize("_run", [1, 2])
def test_symmetric_input_is_deterministic(_run):
    """Four interchangeable staff, no history, nothing to separate them: the
    answer must be stable across runs, broken on (staff_id, start hour)."""
    rota = _rota(sessions=[
        row for staff_id in (D, C, B, A) for row in _rows(staff_id, range(20))
    ])
    blocks = select_front_desk_blocks(rota, set(), _counters())
    assert [b.staff_id for b in blocks] == [A, B, C]
