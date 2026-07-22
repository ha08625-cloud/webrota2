"""Extra session schemas (extra sessions plan, Task 1)."""
import datetime

from pydantic import BaseModel

from ...models.enums import Period


class ExtraSessionIn(BaseModel):
    doctor_id: int
    date: datetime.date
    period: Period


class ExtraSessionOut(ExtraSessionIn):
    id: int
    model_config = {"from_attributes": True}