"""Generation engine package.

Built up across M2 steps 1-9:
  1. datatypes.py, week_map.py
  2. context.py
  3. phases/phase0.py
  4. phases/phase2.py
  5. phases/phase4.py
  6. phases/phase5.py
  7. phases/phase7_9a.py         <- this step
  8. phases/phase9b.py
  9. phases/phase12.py, generate.py

Re-exports are added here as each piece lands; kept minimal for now so this
file doesn't reference modules that don't exist yet.
"""
from .context import load_context
from .datatypes import (
    ClinicDoctorEligibility,
    ClinicSchedule,
    ClinicTypeInfo,
    CounterState,
    GenerationContext,
    GenerationResult,
    RotaGrid,
    SessionSlot,
    ValidationIssue,
)
from .phases import run_phase0, run_phase2, run_phase4, run_phase5, run_phase7_to_9a
from .week_map import DAY_ORDER, build_date_to_genslot, build_week_dates, template_week

__all__ = [
    "ValidationIssue",
    "SessionSlot",
    "RotaGrid",
    "CounterState",
    "ClinicSchedule",
    "ClinicDoctorEligibility",
    "ClinicTypeInfo",
    "GenerationContext",
    "GenerationResult",
    "template_week",
    "build_week_dates",
    "build_date_to_genslot",
    "DAY_ORDER",
    "load_context",
    "run_phase0",
    "run_phase2",
    "run_phase4",
    "run_phase5",
    "run_phase7_to_9a",
]