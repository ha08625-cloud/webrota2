"""The half of the inert rule that `is_inert` cannot state.

`_shared.is_inert` gives an inert doctor property 2 (immovable) at the two
sites that branch per-doctor. Properties 1 and 3 come from an inert type
being *absent from* the phases' demand and victim tuples, which is not
something a predicate can express. These tests are what pin the two halves
together: add a type to `INERT_TYPES` without removing it from the tuples
below and this file fails, which is the only failure mode that matters.
"""
from app.engine.phases import phase7_9a, phase9b, phase9c
from app.engine.phases._shared import INERT_TYPES


def test_inert_types_generate_no_d_room_demand():
    assert set(INERT_TYPES).isdisjoint(phase7_9a._D_ROOM_TYPES)


def test_inert_types_are_never_displaced_in_phase7_9a():
    assert set(INERT_TYPES).isdisjoint(phase7_9a._DISPLACEABLE_TYPES)


def test_inert_types_are_never_wfh_swapped():
    assert set(INERT_TYPES).isdisjoint(phase9b._SWAPPABLE_TYPES)


def test_inert_types_are_never_seated_as_supervisors():
    assert set(INERT_TYPES).isdisjoint(phase9c._SUPERVISOR_TYPES)
