"""School and SchoolHoliday schemas (global planning data, zero engine
coupling -- see models/school.py)."""
import datetime

from pydantic import BaseModel, Field, model_validator

MAX_SCHOOL_HOLIDAY_SPAN_DAYS = 366


class SchoolHolidayIn(BaseModel):
    start_date: datetime.date
    end_date: datetime.date
    name: str | None = None

    @model_validator(mode="after")
    def _check_range(self) -> "SchoolHolidayIn":
        # Unlike ClosureIn, no weekday check: a school holiday routinely
        # starts/ends on weekend-adjacent boundaries and spans weekends
        # throughout (Design Decision 4). This is deliberate, not an
        # oversight.
        if self.end_date < self.start_date:
            raise ValueError("end_date must not be before start_date")
        if (self.end_date - self.start_date).days > MAX_SCHOOL_HOLIDAY_SPAN_DAYS:
            raise ValueError(
                f"holiday span must not exceed {MAX_SCHOOL_HOLIDAY_SPAN_DAYS} days"
            )
        return self


class SchoolHolidayOut(SchoolHolidayIn):
    id: int
    school_id: int
    model_config = {"from_attributes": True}


class SchoolIn(BaseModel):
    name: str = Field(min_length=1)

    @model_validator(mode="after")
    def _strip_name(self) -> "SchoolIn":
        stripped = self.name.strip()
        if not stripped:
            raise ValueError("name must not be blank")
        self.name = stripped
        return self


class SchoolOut(BaseModel):
    id: int
    name: str
    holidays: list[SchoolHolidayOut] = []
    model_config = {"from_attributes": True}
