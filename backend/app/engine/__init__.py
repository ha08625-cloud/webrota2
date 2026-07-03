"""Generation engine package. M2 complete.

  datatypes.py            core in-memory structures
  week_map.py              generation-week <-> template-week <-> date mapping
  context.py                load_context(): read all reference data once
  phases/                    phase0, phase2, phase4, phase5, phase7_9a,
                              phase9b, phase12
  generate.py                orchestrator + _write_to_db()

Usage: `generate(db_session, config_id)` inside a transaction; see
generate.py for details.
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
from .generate import generate
from .phases import (
    run_phase0,
    run_phase2,
    run_phase4,
    run_phase5,
    run_phase7_to_9a,
    run_phase9b,
    run_phase12,
)
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
    "run_phase9b",
    "run_phase12",
    "generate",
]
