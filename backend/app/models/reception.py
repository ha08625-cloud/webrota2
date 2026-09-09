"""Reception rota models: staff, weekday master template, generated days, and
leave. Phone-coverage minimum staffing is a function of the hour of day
(min_phones_for_hour below), not a model -- there is no coverage-rules table.

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
# CheckConstraints below and the schema baseline) is how the DB rejects
# anything that isn't a clean half-hour, e.g. 8.25.
HOUR_HALF_STEP_SQL = "(hour * 2) = CAST(hour * 2 AS INTEGER)"


def _hour_label(hour: float) -> str:
    whole = int(hour)
    minutes = "30" if hour - whole >= 0.5 else "00"
    return f"{whole:02d}:{minutes}"


def format_hour(hour: float) -> str:
    """format_hour(8.5) -> "08:30-09:00". Mirrors formatHour in
    frontend/src/lib/receptionHours.ts -- the single formatter on each side,
    kept in sync by hand since nothing generates one from the other."""
    return f"{_hour_label(hour)}-{_hour_label(hour + 0.5)}"


def format_hour_range(start: float, end_exclusive: float) -> str:
    """format_hour_range(8.0, 13.0) -> "08:00-13:00", for a span of several
    slots rather than the single slot format_hour renders. `end_exclusive` is
    the hour the range stops at, i.e. the start of the first slot *not* in it.
    Server-rendered only -- unlike format_hour there is no frontend mirror to
    keep in sync."""
    return f"{_hour_label(start)}-{_hour_label(end_exclusive)}"


class ReceptionStaff(Base):
    __tablename__ = "reception_staff"
    __table_args__ = (UniqueConstraint("code", name="uq_reception_staff_code"),)

    id: Mapped[int] = mapped_column(primary_key=True)
    # `code` is the only identifier: it is what every grid row header, sort
    # order and confirm prompt uses, and it is unique. There is deliberately
    # no separate `name` -- the two were the same thing in practice, and the
    # frontend simply labels this field "Name" (two Emilys are distinguished
    # by typing "Emily M"/"Emily S"). Mirrors Doctor, which is code-only too.
    code: Mapped[str] = mapped_column(String, nullable=False)
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
    __table_args__ = (UniqueConstraint("date", name="uq_reception_rotas_date"),)

    id: Mapped[int] = mapped_column(primary_key=True)
    date: Mapped[datetime.date] = mapped_column(Date, nullable=False)
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
    not change that day.

    **`displaced_role` invariant: non-null <=> an assigner wrote this
    slot**, and it holds the role that was on the row immediately before
    that assigner overwrote it. Nothing else in the system ever sets it
    non-null.

    There are two assigners, both inside `POST /reception/rota/{id}/assign`
    and both writing this column: the front-desk step
    (`reception_front_desk`, overwriting with `front_desk`) and the phones
    top-up that runs immediately after it (`reception_phones`, overwriting
    `online_triage` with `phones`). Assigners record assignments by
    overwriting `role` in place rather than in an overlay table, so this
    column is how a re-run puts back what they took. It is set on every slot
    either of them writes, *even when that makes the eventual restore a no-op
    because the previous role was already the role being written* (which the
    desk step can do, and the top-up cannot since it only ever takes
    `online_triage` rows), so that the invariant is total and the reset step
    -- which runs once, before both -- can be a simple "restore every row
    with a non-null displaced_role" without needing to know which assigner
    wrote it.

    Consequences worth keeping in mind:

    - A `front_desk` role tagged by hand has a NULL `displaced_role`, so a
      re-run of the assigner leaves it untouched.
    - A manual PATCH of a slot clears `displaced_role` back to NULL -- the
      user has overridden the slot, and a later reset must not resurrect a
      role that is no longer what the day says.

    This is internal bookkeeping: it is deliberately not exposed in
    ReceptionRotaSessionOut or any other schema, and the template
    (ReceptionMasterSession) has no equivalent because it carries no
    assignments.
    """

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
    displaced_role: Mapped[ReceptionRole | None] = mapped_column(
        enum_col(ReceptionRole), nullable=True, default=None
    )

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


# Minimum phones headcount required at a slot. Varies by hour of day but
# never by weekday, and there is no coverage-rules table and no UI to edit
# it -- the shape of the phone day is a property of the phone lines, not
# something a user configures. Read via min_phones_for_hour() below.
#
# The standard requirement across the working day.
MIN_PHONES_STAFF = 2
# 7:30-8:00: the lines are not open yet, so no cover is required at all.
PHONES_OPEN_HOUR = 8.0
# 17:00 onwards (17:00, 17:30 and the closing 18:00-18:30 slot): calls are
# light enough that one person is enough.
PHONES_QUIET_HOUR = 17.0
MIN_PHONES_STAFF_QUIET = 1


def min_phones_for_hour(hour: float) -> int:
    """Phones headcount required at the half-hour slot starting `hour`.

    Read by compute_coverage_issues in app/api/routers/reception_rota.py
    (which warns when the rota is below it), by reception_front_desk.py
    (which penalises pushing an hour below it) and by reception_phones.py
    (which derives its window and its per-hour deficits from it)."""
    if hour < PHONES_OPEN_HOUR:
        return 0
    if hour >= PHONES_QUIET_HOUR:
        return MIN_PHONES_STAFF_QUIET
    return MIN_PHONES_STAFF
