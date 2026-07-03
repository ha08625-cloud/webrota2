"""Phase implementations for the generation engine.

Each module exposes a single `run_phaseN(...)` function operating on a
`GenerationContext` (and, from Phase 2 onward, a `RotaGrid`/`CounterState`).
See ../datatypes.py for the shared types passed between them.

Built up across M2 steps 3-9:
  3. phase0.py       <- done
  4. phase2.py       <- done
  5. phase4.py       <- done
  6. phase5.py       <- done
  7. phase7_9a.py     <- done
  8. phase9b.py       <- this step
  9. phase12.py
"""
from .phase0 import run_phase0
from .phase2 import run_phase2
from .phase4 import run_phase4
from .phase5 import run_phase5
from .phase7_9a import run_phase7_to_9a
from .phase9b import run_phase9b

__all__ = [
    "run_phase0", "run_phase2", "run_phase4", "run_phase5",
    "run_phase7_to_9a", "run_phase9b",
]
