"""Leave schemas."""
import datetime

from pydantic import BaseModel

from ...models.enums import Period


class LeaveIn(BaseModel):
    doctor_id: int
    date: datetime.date
    period: Period


class LeaveOut(LeaveIn):
    id: int
    model_config = {"from_attributes": True}
