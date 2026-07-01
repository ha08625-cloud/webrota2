"""Phase implementations for the generation engine.

Each module exposes a single `run_phaseN(...)` function operating on a
`GenerationContext` (and, from Phase 2 onward, a `RotaGrid`/`CounterState`).
See ../datatypes.py for the shared types passed between them.

Built up across M2 steps 3-9:
  3. phase0.py   <- done
  4. phase2.py   <- done
  5. phase4.py   <- this step
  6. phase5.py
  7. phase7_9a.py
  8. phase9b.py
  9. phase12.py
"""
from .phase0 import run_phase0
from .phase2 import run_phase2
from .phase4 import run_phase4

__all__ = ["run_phase0", "run_phase2", "run_phase4"]