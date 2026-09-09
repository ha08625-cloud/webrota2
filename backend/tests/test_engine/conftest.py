"""Shared fixtures for engine tests.

`session`/`engine` (in-memory SQLite, FK enforcement on) come from the
project-level `tests/conftest.py`. Fixtures here are small conveniences
reused across phase test files, built inline per the M2 plan's fixture
strategy — nothing is seeded from CSV.
"""
import datetime

import pytest

from app.models import RotaConfig


@pytest.fixture
def monday() -> datetime.date:
    """A fixed Monday used as the default start_date across engine tests."""
    return datetime.date(2026, 1, 5)


@pytest.fixture
def config_1wk(monday) -> RotaConfig:
    """An unpersisted RotaConfig: 1 generation week, template_start_week=1.

    Not added to the session — `load_context()` only reads plain attributes,
    so no id/FK is needed for engine-level tests.
    """
    return RotaConfig(start_date=monday, num_weeks=1, template_start_week=1)


@pytest.fixture
def config_2wk(monday) -> RotaConfig:
    return RotaConfig(start_date=monday, num_weeks=2, template_start_week=1)