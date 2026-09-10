"""Shared schema types."""
from pydantic import BaseModel

from ...models.enums import Day, Period


class ValidationIssueOut(BaseModel):
    """API shape of engine.datatypes.ValidationIssue (1:1 fields)."""
    severity: str
    phase: str
    check: str
    message: str
    week: int | None = None
    day: Day | None = None
    period: Period | None = None
    doctor_id: int | None = None

    model_config = {"from_attributes": True}
