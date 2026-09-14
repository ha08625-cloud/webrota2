"""DutyOpeningBalance model.

One optional row per (doctor, year), the sibling of `LeaveEntitlement` and
keyed the same way for the same reason: the duty count the annual weighted
score divides is derived per calendar year (`GET /duty/counts` over a
`from_date`/`to_date` range), so a balance that outlived its year would keep
crediting someone who is no longer a new starter -- and by the next 1
January every doctor is genuinely level again, because the count itself
restarts.

`sessions` is a credit in duty sessions, added to the counted duty total
before it is divided by `Doctor.sessions_per_week`. A doctor who joins
part-way through the year otherwise starts at zero, which reads as
"maximally under-loaded" and makes them the grid's suggested pick for weeks.
The figure that puts a joiner level with the group is
`peer_weighted_score x their_sessions_per_week` -- i.e. start them at the
group's current score rather than at zero -- which is why the credit is
denominated in *duty* sessions rather than in the working sessions they
would have done: every counter in the system counts something far rarer
than the whole working week.

No row means a zero balance, so nothing has to be seeded and the common
case (a doctor who was here on 1 January) carries no row at all. Negative
values are allowed and deliberately not constrained: the mirror case -- a
doctor returning from a long absence, or a leaver whose count should read as
already served -- is real.
"""
from decimal import Decimal

from sqlalchemy import ForeignKey, Integer, Numeric, String, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column

from ..database import Base

NOTES_MAX_LENGTH = 200


class DutyOpeningBalance(Base):
    __tablename__ = "duty_opening_balances"
    __table_args__ = (
        UniqueConstraint(
            "doctor_id", "year", name="uq_duty_opening_balance_doctor_year"
        ),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    doctor_id: Mapped[int] = mapped_column(ForeignKey("doctors.id"), nullable=False)
    # Calendar year the balance applies to. The duty count runs 1 Jan to 31
    # Dec, so a bare year is a complete key -- no start/end columns to keep
    # consistent with each other.
    year: Mapped[int] = mapped_column(Integer, nullable=False)
    sessions: Mapped[Decimal] = mapped_column(
        Numeric(5, 1), nullable=False, default=Decimal("0.0"), server_default="0"
    )
    notes: Mapped[str | None] = mapped_column(String(NOTES_MAX_LENGTH), nullable=True)

    def __repr__(self) -> str:  # pragma: no cover
        return f"<DutyOpeningBalance doctor={self.doctor_id} year={self.year}>"
