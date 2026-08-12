"""Reception rota models: staff, weekday master template, generated days, and
coverage rules.

Independent of the clinical rota (doctors, master_rota, engine/) end to end --
the only things shared are auth, the app shell, the HTTP client, and
deployment. Reception has a much simpler shape than the clinical rota: one
day at a time, half-hourly slots 7:30am-6:30pm (RECEPTION_HOURS, twenty-two
per day),
one role per staff member per slot (phones/other).

**Half-hour granularity.** `hour` stays the field/column name everywhere --
it is still "the hour of day a slot starts" -- but it is a float, not an
int: valid values are X.0 or X.5 (e.g. 8.5 is 8:30am), not just whole hours.
This was chosen over renaming `hour` to something like `slot` (which would
have touched the API contract, every schema/router/frontend reference, and
every test) because X.5 reads unambiguously as a half hour and the column's
meaning does not change, only its precision. RECEPTION_FIRST_HOUR/
RECEPTION_LAST_HOUR/RECEPTION_HOURS below are unchanged in spirit from the
original hourly model (still mirrored in the frontend's
lib/receptionHours.ts, still "widening opening hours is a migration") --
only the step between values shrank from 1 to 0.5.

Row existence is the data, exactly as on master_rota_sessions: a staff member
with no row for a given (day, hour) is not expected at that hour. Editing a
working pattern means creating and deleting rows, not only updating them.
This applies identically to reception_master_sessions (the weekday template)
and reception_rota_sessions (a generated day).

A generated day is a ReceptionRota header plus ReceptionRotaSession rows,
copied from the template at generate time and never re-derived afterwards --
the same self-contained-snapshot principle as RotaSession.template_type. The
header exists solely so "never generated" (no header) is distinguishable from
"generated, then every row deleted" (header with no sessions); there is no
status/lifecycle column because none is needed with no draft/commit concept.

Absence: ReceptionLeaveEntry records whole-day
absence, and coverage validation excludes anyone on leave from the phones
headcount. That is the *only* thing leave changes -- generation still copies
every active staff member's template rows onto a day, and their rows stay on
a day they are later marked off for. Deleting a row therefore remains a
valid way to say "not working this slot" (the clinical rota's "cell absence
is data" convention); leave is an additional, coarser fact layered on top of
it, not a replacement.
"""
import datetime

from sqlalchemy import (
    Boolean,
    CheckConstraint,
    Date,
    DateTime,
    Float,
    ForeignKey,
    Integer,
    String,
    UniqueConstraint,
)
from sqlalchemy.orm import Mapped, mapped_column, relationship

from ..database import Base
from .enums import Day, ReceptionRole, enum_col

RECEPTION_FIRST_HOUR = 7.5
RECEPTION_LAST_HOUR = 18.0
_RECEPTION_SLOT_COUNT = int(round((RECEPTION_LAST_HOUR - RECEPTION_FIRST_HOUR) / 0.5)) + 1
RECEPTION_HOURS = [RECEPTION_FIRST_HOUR + 0.5 * i for i in range(_RECEPTION_SLOT_COUNT)]

# Every valid `hour` value is exactly n * 0.5 for an integer n -- (hour * 2)
# is then a whole number, and this expression (used by both the model's
# CheckConstraints below and the Alembic baseline) is how the DB rejects anything
# that isn't a clean half-hour, e.g. 8.25.
HOUR_HALF_STEP_SQL = "(hour * 2) = CAST(hour * 2 AS INTEGER)"


def format_hour(hour: float) -> str:
    """format_hour(8.5) -> "08:30-09:00". Mirrors formatHour in
    frontend/src/lib/receptionHours.ts -- the single formatter on each side,
    kept in sync by hand since nothing generates one from the other."""
    def _label(h: float) -> str:
        whole = int(h)
        minutes = "30" if h - whole >= 0.5 else "00"
        return f"{whole:02d}:{minutes}"
    return f"{_label(hour)}-{_label(hour + 0.5)}"


class ReceptionStaff(Base):
    __tablename__ = "reception_staff"

    id: Mapped[int] = mapped_column(primary_key=True)
    code: Mapped[str] = mapped_column(String, unique=True, nullable=False)
    name: Mapped[str] = mapped_column(String, nullable=False)
    active: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)

    def __repr__(self) -> str:  # pragma: no cover
        return f"<ReceptionStaff {self.code}>"


class ReceptionMasterSession(Base):
    """One weekday master template, keyed by (staff, day, hour) -- not five
    separate per-weekday templates. There is no header/version table: no
    active/inactive concept and no staging exist for reception, so a header
    would only reproduce master_rota_templates.is_active's documented
    ambiguity for no benefit."""

    __tablename__ = "reception_master_sessions"
    __table_args__ = (
        CheckConstraint(
            f"hour BETWEEN {RECEPTION_FIRST_HOUR} AND {RECEPTION_LAST_HOUR} "
            f"AND {HOUR_HALF_STEP_SQL}",
            name="ck_rms_hour",
        ),
        UniqueConstraint("staff_id", "day", "hour", name="uq_rms_slot"),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    staff_id: Mapped[int] = mapped_column(
        ForeignKey("reception_staff.id"), nullable=False
    )
    day: Mapped[Day] = mapped_column(enum_col(Day), nullable=False)
    hour: Mapped[float] = mapped_column(Float, nullable=False)
    role: Mapped[ReceptionRole] = mapped_column(
        enum_col(ReceptionRole), nullable=False, default=ReceptionRole.PHONES
    )
    note: Mapped[str | None] = mapped_column(String(200), nullable=True)

    staff: Mapped["ReceptionStaff"] = relationship()


class ReceptionRota(Base):
    """Header for one generated day. Carries nothing but the date and when it
    was generated -- its sole purpose is to distinguish "never generated"
    (no header for this date) from "generated, then every row deleted"
    (header exists, no sessions), since without it the day page cannot tell
    which of "Generate" or "you are editing an existing day" to offer."""

    __tablename__ = "reception_rotas"

    id: Mapped[int] = mapped_column(primary_key=True)
    date: Mapped[datetime.date] = mapped_column(Date, unique=True, nullable=False)
    created_at: Mapped[datetime.datetime] = mapped_column(
        DateTime(timezone=True),
        nullable=False,
        default=lambda: datetime.datetime.now(datetime.timezone.utc),
    )

    sessions: Mapped[list["ReceptionRotaSession"]] = relationship(
        back_populates="rota", cascade="all, delete-orphan"
    )


class ReceptionRotaSession(Base):
    """A generated day's rows. Self-contained snapshots copied from the
    weekday template at generate time -- never re-derived from the template
    at read time, so an edit to the template after a day is generated does
    not change that day."""

    __tablename__ = "reception_rota_sessions"
    __table_args__ = (
        CheckConstraint(
            f"hour BETWEEN {RECEPTION_FIRST_HOUR} AND {RECEPTION_LAST_HOUR} "
            f"AND {HOUR_HALF_STEP_SQL}",
            name="ck_rrs_hour",
        ),
        UniqueConstraint("rota_id", "staff_id", "hour", name="uq_rrs_slot"),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    rota_id: Mapped[int] = mapped_column(
        ForeignKey("reception_rotas.id"), nullable=False
    )
    staff_id: Mapped[int] = mapped_column(
        ForeignKey("reception_staff.id"), nullable=False
    )
    hour: Mapped[float] = mapped_column(Float, nullable=False)
    role: Mapped[ReceptionRole] = mapped_column(
        enum_col(ReceptionRole), nullable=False, default=ReceptionRole.PHONES
    )
    note: Mapped[str | None] = mapped_column(String(200), nullable=True)

    rota: Mapped["ReceptionRota"] = relationship(back_populates="sessions")
    staff: Mapped["ReceptionStaff"] = relationship()


class ReceptionLeaveEntry(Base):
    """One whole day off for one reception staff member.

    Deliberately thinner than the clinical LeaveEntry: no `period` column
    and no `notes`. Reception's day is twenty half-hourly slots, so an
    AM/PM split would be an arbitrary line through the middle of it, and
    the finer-grained "off from 2pm" case is already expressible -- and
    more precisely -- by deleting the slots or tagging them
    `not_working`. This table answers exactly one question, "is this
    person off on this date", which is the question coverage needs.

    Absence of a row is not "present": a staff member with no row here is
    simply not known to be away, and their rows count toward coverage as
    they always did.
    """

    __tablename__ = "reception_leave_entries"
    __table_args__ = (
        UniqueConstraint("staff_id", "date", name="uq_rle_slot"),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    staff_id: Mapped[int] = mapped_column(
        ForeignKey("reception_staff.id"), nullable=False
    )
    date: Mapped[datetime.date] = mapped_column(Date, nullable=False)

    staff: Mapped["ReceptionStaff"] = relationship()


class ReceptionCoverageRule(Base):
    """Minimum phones headcount required for a (day, hour) slot. Keyed on
    day as well as hour -- Monday 9am and Friday 3pm are not the same
    staffing problem, and adding the day dimension later would cost a
    migration, a seed backfill, and a rules-page rework, versus one extra
    column and 40 more seed rows now.

    A missing (day, hour) row reads as no minimum (no warning possible),
    not as zero-required-and-therefore-satisfied -- the same outcome, but
    an explicit modelling choice rather than an accident of an empty table.
    """

    __tablename__ = "reception_coverage_rules"
    __table_args__ = (
        CheckConstraint(
            f"hour BETWEEN {RECEPTION_FIRST_HOUR} AND {RECEPTION_LAST_HOUR} "
            f"AND {HOUR_HALF_STEP_SQL}",
            name="ck_rcr_hour",
        ),
        UniqueConstraint("day", "hour", name="uq_rcr_slot"),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    day: Mapped[Day] = mapped_column(enum_col(Day), nullable=False)
    hour: Mapped[float] = mapped_column(Float, nullable=False)
    min_phones_staff: Mapped[int] = mapped_column(Integer, nullable=False)
