import math

import pytest

from app.engine.datatypes import (
    ClinicDoctorEligibility,
    ClinicSchedule,
    ClinicTypeInfo,
    CounterState,
    DecisionLog,
    DecisionLogEntry,
    RotaGrid,
    SessionSlot,
    ValidationIssue,
)
from app.models.enums import Day, MasterSessionType, Period, SessionRole, SystemCounterType


class TestValidationIssue:
    def test_frozen_and_defaults(self):
        issue = ValidationIssue(
            severity="warning", phase="phase5", check="no_eligible_doctor",
            message="No eligible doctor for Dragon Monday AM",
        )
        assert issue.week is None
        assert issue.day is None
        assert issue.period is None
        with pytest.raises(AttributeError):
            issue.severity = "error"  # frozen

    def test_error_severity(self):
        issue = ValidationIssue(
            severity="error", phase="phase0", check="duty_on_leave",
            message="doctor on leave during duty", week=1, day=Day.MONDAY, period=Period.AM,
        )
        assert issue.severity == "error"


class TestSessionSlot:
    def test_key_and_has_role(self):
        slot = SessionSlot(
            doctor_id=7, week=1, day=Day.MONDAY, period=Period.AM,
            template_type=MasterSessionType.REQUIRES_ROOM,
        )
        assert slot.key == (7, 1, Day.MONDAY, Period.AM)
        assert slot.has_role is False
        slot.role = SessionRole.CLINIC
        assert slot.has_role is True

    def test_defaults(self):
        slot = SessionSlot(
            doctor_id=1, week=1, day=Day.TUESDAY, period=Period.PM,
            template_type=MasterSessionType.NO_SURGERY,
        )
        assert slot.assigned_room_id is None
        assert slot.clinic_type_id is None
        assert slot.is_on_leave is False
        assert slot.is_wfh is False
        assert slot.notes is None


class TestRotaGrid:
    def _slot(self, doctor_id, week=1, day=Day.MONDAY, period=Period.AM):
        return SessionSlot(
            doctor_id=doctor_id, week=week, day=day, period=period,
            template_type=MasterSessionType.REQUIRES_ROOM,
        )

    def test_add_and_get(self):
        grid = RotaGrid()
        slot = self._slot(1)
        grid.add_slot(slot)
        assert grid.get(1, 1, Day.MONDAY, Period.AM) is slot
        assert grid.get(2, 1, Day.MONDAY, Period.AM) is None

    def test_sessions_for_slot(self):
        grid = RotaGrid()
        grid.add_slot(self._slot(1))
        grid.add_slot(self._slot(2))
        grid.add_slot(self._slot(3, day=Day.TUESDAY))
        found = grid.sessions_for_slot(1, Day.MONDAY, Period.AM)
        assert {s.doctor_id for s in found} == {1, 2}

    def test_assign_room_updates_both_indexes_and_slot(self):
        grid = RotaGrid()
        slot = self._slot(1)
        grid.add_slot(slot)
        grid.assign_room(1, Day.MONDAY, Period.AM, doctor_id=1, room_id=101)
        assert slot.assigned_room_id == 101
        assert grid.get_doctor_room(1, Day.MONDAY, Period.AM, 1) == 101
        assert grid.is_room_free(1, Day.MONDAY, Period.AM, 101) is False

    def test_assign_room_frees_previous_room_first(self):
        grid = RotaGrid()
        slot = self._slot(1)
        grid.add_slot(slot)
        grid.assign_room(1, Day.MONDAY, Period.AM, doctor_id=1, room_id=101)
        grid.assign_room(1, Day.MONDAY, Period.AM, doctor_id=1, room_id=102)
        assert grid.is_room_free(1, Day.MONDAY, Period.AM, 101) is True
        assert grid.is_room_free(1, Day.MONDAY, Period.AM, 102) is False
        assert grid.get_doctor_room(1, Day.MONDAY, Period.AM, 1) == 102

    def test_free_room_vacates_and_clears_slot(self):
        grid = RotaGrid()
        slot = self._slot(1)
        grid.add_slot(slot)
        grid.assign_room(1, Day.MONDAY, Period.AM, doctor_id=1, room_id=101)
        grid.free_room(1, Day.MONDAY, Period.AM, doctor_id=1)
        assert slot.assigned_room_id is None
        assert grid.is_room_free(1, Day.MONDAY, Period.AM, 101) is True
        assert grid.get_doctor_room(1, Day.MONDAY, Period.AM, 1) is None

    def test_free_room_noop_when_nothing_assigned(self):
        grid = RotaGrid()
        grid.add_slot(self._slot(1))
        grid.free_room(1, Day.MONDAY, Period.AM, doctor_id=1)  # should not raise

    def test_two_doctors_different_rooms_same_slot(self):
        grid = RotaGrid()
        grid.add_slot(self._slot(1))
        grid.add_slot(self._slot(2))
        grid.assign_room(1, Day.MONDAY, Period.AM, doctor_id=1, room_id=101)
        grid.assign_room(1, Day.MONDAY, Period.AM, doctor_id=2, room_id=102)
        assert grid.is_room_free(1, Day.MONDAY, Period.AM, 101) is False
        assert grid.is_room_free(1, Day.MONDAY, Period.AM, 102) is False
        assert grid.get_doctor_room(1, Day.MONDAY, Period.AM, 1) == 101
        assert grid.get_doctor_room(1, Day.MONDAY, Period.AM, 2) == 102


class TestCounterState:
    def test_missing_key_treated_as_zero(self):
        cs = CounterState()
        assert cs.weighted_clinic_score(1, 1, spw=8.0) == 0.0
        assert cs.weighted_system_score(1, SystemCounterType.ROOM_MOVE, spw=8.0) == 0.0

    def test_spw_zero_returns_inf(self):
        cs = CounterState()
        cs.increment_clinic(1, 1)
        assert cs.weighted_clinic_score(1, 1, spw=0) == math.inf
        assert cs.weighted_system_score(1, SystemCounterType.ROOM_MOVE, spw=0) == math.inf

    def test_spw_zero_returns_inf_regardless_of_multiplier(self):
        # The spw==0 short-circuit must ignore multiplier entirely - an
        # undefined score stays undefined no matter how it would have been
        # scaled. Covers both a below-1 and an above-1 multiplier.
        cs = CounterState()
        cs.increment_system(1, SystemCounterType.SUPERVISION)
        assert cs.weighted_system_score(1, SystemCounterType.SUPERVISION, spw=0, multiplier=0.66) == math.inf
        assert cs.weighted_system_score(1, SystemCounterType.SUPERVISION, spw=0, multiplier=1_000_000) == math.inf

    def test_weighted_system_score_default_multiplier_is_unscaled(self):
        # No multiplier passed -- existing ROOM_MOVE callers must see
        # identical behaviour to before the parameter existed.
        cs = CounterState()
        cs.increment_system(1, SystemCounterType.ROOM_MOVE)
        cs.increment_system(1, SystemCounterType.ROOM_MOVE)
        assert cs.weighted_system_score(1, SystemCounterType.ROOM_MOVE, spw=4.0) == 0.5

    def test_weighted_system_score_applies_multiplier(self):
        cs = CounterState()
        cs.increment_system(1, SystemCounterType.SUPERVISION)
        cs.increment_system(1, SystemCounterType.SUPERVISION)
        # raw=2, spw=4.0 -> unscaled 0.5; multiplier=1.5 -> 0.75
        assert cs.weighted_system_score(1, SystemCounterType.SUPERVISION, spw=4.0, multiplier=1.5) == 0.75

    def test_increment_clinic_and_weighted_score(self):
        cs = CounterState()
        cs.increment_clinic(1, 1)
        cs.increment_clinic(1, 1)
        assert cs.clinic[(1, 1)] == 2
        assert cs.weighted_clinic_score(1, 1, spw=4.0) == 0.5

    def test_increment_system(self):
        cs = CounterState()
        cs.increment_system(1, SystemCounterType.SUPERVISION)
        assert cs.system[(1, SystemCounterType.SUPERVISION)] == 1

    def test_new_clinic_key_tracking(self):
        cs = CounterState()
        assert cs.is_new_clinic_key(1, 1) is False
        cs.increment_clinic(1, 1)
        assert cs.is_new_clinic_key(1, 1) is True
        # a pre-existing key loaded from the DB should not be tracked as new
        cs2 = CounterState(clinic={(2, 1): 3})
        assert cs2.is_new_clinic_key(2, 1) is False
        cs2.increment_clinic(2, 1)
        assert cs2.is_new_clinic_key(2, 1) is False  # already existed
        assert cs2.clinic[(2, 1)] == 4

    def test_separate_doctors_separate_counters(self):
        cs = CounterState()
        cs.increment_clinic(1, 1)
        assert cs.clinic.get((2, 1), 0) == 0

    def test_separate_clinic_types_are_independent(self):
        # Two different ClinicType rows have independent counters even for
        # the same doctor -- this is the "separate counters via clinic-type
        # modelling" referenced in the M2 plan, not a per-slot mechanism.
        cs = CounterState()
        cs.increment_clinic(1, clinic_type_id=1)
        assert cs.clinic.get((1, 2), 0) == 0


class TestClinicTypeInfo:
    def test_construction(self):
        info = ClinicTypeInfo(
            id=1, name="Dragon", clinic_priority=10, room_required=True,
            schedules=(ClinicSchedule(day=Day.MONDAY, period=Period.AM),),
            doctor_eligibilities=(ClinicDoctorEligibility(doctor_id=1, doctor_priority=1),),
            eligible_room_ids=(101, 102),
        )
        assert info.name == "Dragon"
        assert info.schedules[0].day == Day.MONDAY
        assert info.doctor_eligibilities[0].doctor_priority == 1


class TestDecisionLogEntry:
    def test_frozen_and_defaults(self):
        entry = DecisionLogEntry(
            sequence=0, phase="phase5", action="assign_clinic",
            message="Dr AA assigned to Dragon Monday AM",
        )
        assert entry.week is None
        assert entry.day is None
        assert entry.period is None
        assert entry.doctor_id is None
        assert entry.related_doctor_id is None
        assert entry.room_id is None
        assert entry.related_room_id is None
        assert entry.clinic_type_id is None
        with pytest.raises(AttributeError):
            entry.sequence = 1  # frozen


class TestDecisionLog:
    def test_add_assigns_monotonic_sequence(self):
        log = DecisionLog()
        log.add(phase="phase5", action="assign_clinic", message="first")
        log.add(phase="phase5", action="assign_clinic", message="second")
        log.add(phase="phase9b", action="resolve_swap", message="third")
        assert [e.sequence for e in log.entries] == [0, 1, 2]
        assert [e.message for e in log.entries] == ["first", "second", "third"]

    def test_add_starts_empty(self):
        log = DecisionLog()
        assert log.entries == []

    def test_add_passes_through_optional_fields(self):
        log = DecisionLog()
        log.add(
            phase="phase7_9a", action="displace_room",
            message="Dr AA displaced Dr BB from D4 to D5",
            week=1, day=Day.MONDAY, period=Period.AM,
            doctor_id=1, related_doctor_id=2, room_id=101, related_room_id=102,
        )
        entry = log.entries[0]
        assert entry.phase == "phase7_9a"
        assert entry.action == "displace_room"
        assert entry.doctor_id == 1
        assert entry.related_doctor_id == 2
        assert entry.room_id == 101
        assert entry.related_room_id == 102
        assert entry.week == 1
        assert entry.day == Day.MONDAY
        assert entry.period == Period.AM

    def test_entries_are_independent_dataclass_instances(self):
        log = DecisionLog()
        log.add(phase="phase5", action="assign_clinic", message="a")
        log.add(phase="phase5", action="assign_clinic", message="b")
        assert log.entries[0] is not log.entries[1]
        assert log.entries[0].message != log.entries[1].message