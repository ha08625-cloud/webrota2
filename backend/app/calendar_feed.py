"""Per-doctor `.ics` calendar feed (calendar feed plan, Task 2).

Builds the iCalendar bytes for one doctor from the current database state.
Nothing is pre-generated and nothing is cached: every request recomputes the
file, which is what lets the feed tell the truth about a rota that changed
after it was committed. `is_on_leave` is not stored -- it is derived from
`leave_entries` at read time -- so a rollback, a force-delete, or leave
booked after commit all change what this module emits with no `rota_sessions`
row having changed.

What is included, and why:

- **Committed rotas only.** A draft changes constantly and publishing it
  would be noise. `archived_at` is deliberately *not* filtered on: archiving
  is a pure UI visibility flag on a rota that is still real and committed.
- **Sessions the doctor was due at work for**, read off the row's own
  persisted `template_type` snapshot: `REQUIRES_ROOM`, `PRE_ASSIGNED`,
  `ADMIN_TIME`, `WFH`, and legacy `null` rows (which read as a normal
  session everywhere else in the app). `NO_SURGERY` is excluded.

  That is the same set as `app/leave_charging.py`'s chargeable set, and for
  the same reason: both ask "was the doctor due to be at work?" rather than
  `leave_planning`'s narrower "is a clinician available to see patients?".
  **The two predicates are aligned on purpose but deliberately not shared.**
  `leave_charging` answers the question against the *live week-1 master
  template* by weekday, because it is asked about a bare date with no rota;
  this module answers it against the *persisted `template_type` snapshot* on
  a real rota row. A shared function would force one of them onto the wrong
  source.
- **Closures come from the rota's own `RotaClosure` snapshot**, never from
  the live `PracticeClosure` table -- the same rule `GET /rota/{id}` and
  `rebuild_rota_grid()` follow, so a closure edited after commit cannot
  retroactively change what a historical rota's feed says.

The filter order is **closure -> session type -> leave**, so a `NO_SURGERY`
slot on a leave day produces neither a session event nor a leave event, and
a leave event exists only where a session was actually suppressed. That rule
is what keeps the leave query bounded: a part-timer's non-working day, a
weekend, and any date outside every committed rota all stay silent.

This module queries, so it is not DB-free like `leave_entitlement.py`, but it
must not import from `app/api/` -- it is called by the ungated feed route,
not the other way round.
"""
from __future__ import annotations

import datetime
import os
from collections import defaultdict
from zoneinfo import ZoneInfo

from icalendar import Calendar, Event
from sqlalchemy import select
from sqlalchemy.orm import Session

from .engine.week_map import build_week_dates
from .models.clinic_type import ClinicType
from .models.closure import RotaClosure
from .models.doctor import Doctor
from .models.enums import MasterSessionType, Period, RotaStatus, SessionRole
from .models.leave import LeaveEntry
from .models.room import Room
from .models.rota import GeneratedRota, RotaConfig, RotaSession


def _time_env(name: str, default: str) -> datetime.time:
    """Parse an `HH:MM` environment override, falling back to `default`."""
    raw = os.environ.get(name, default)
    hours, _, minutes = raw.partition(":")
    return datetime.time(int(hours), int(minutes))


# The practice holds no clock times anywhere -- `Period` is AM/PM only -- but
# calendar events need them. Practice-wide constants with env-var overrides
# (the `DOC_LOCK_PASSWORD` / `SOFFICE_BIN` precedent), so changing the
# practice's hours is a Railway variable and a redeploy rather than a
# migration. Per-clinic-type and per-doctor times are out of scope.
AM_START = _time_env("CALENDAR_AM_START", "08:30")
AM_END = _time_env("CALENDAR_AM_END", "12:30")
PM_START = _time_env("CALENDAR_PM_START", "13:30")
PM_END = _time_env("CALENDAR_PM_END", "18:00")

PERIOD_TIMES: dict[Period, tuple[datetime.time, datetime.time]] = {
    Period.AM: (AM_START, AM_END),
    Period.PM: (PM_START, PM_END),
}

# How far back the feed reaches. Nobody subscribes to a calendar to read last
# year, and emitting all history forever grows the file without bound. There
# is no upper bound: committed rotas only extend a few weeks out anyway.
HISTORY_DAYS = int(os.environ.get("CALENDAR_FEED_HISTORY_DAYS", "56"))

# The UID domain is a hardcoded constant and is deliberately NOT derived from
# the request host and NOT env-overridable. A client updates an existing event
# rather than duplicating it when the UID matches; deriving the domain from
# `request.base_url` would change every UID the day the app moves domain (or
# the first time someone subscribes via the Railway URL instead of the
# practice one), and every event in every subscriber's calendar would
# duplicate rather than update.
UID_DOMAIN = "rota.local"

PRACTICE_TZ = ZoneInfo("Europe/London")

# Sessions are stored as bare dates. Times are emitted as explicit UTC
# (`DTSTART:...Z`) converted from Europe/London, which handles BST correctly,
# needs no VTIMEZONE block, and adds no dependency. Floating local times would
# be nearly correct for a single-site practice and wrong for anyone travelling.
PRACTICE_TZ_NAME = "Europe/London"

# How often a subscribing client is asked to re-fetch. Clients honour one or
# the other of these, neither universally, so both are emitted.
REFRESH_INTERVAL = datetime.timedelta(hours=12)
REFRESH_INTERVAL_TEXT = "PT12H"

# `template_type` values that mean the doctor was due to be at work. A legacy
# `null` row is included too (see the module docstring) and is handled by the
# `is not` check rather than by membership.
EXCLUDED_TEMPLATE_TYPE = MasterSessionType.NO_SURGERY

LEAVE_SUMMARY = "Annual leave"


def _rota_end_date(config: RotaConfig) -> datetime.date:
    """The day after the last day the rota covers."""
    return config.start_date + datetime.timedelta(days=config.num_weeks * 7)


def _activity_label(session: RotaSession, clinic_name: str | None) -> str:
    """The clinic-type half of the summary line.

    Mirrors the grid's own labelling (`frontend/src/lib/exportContent.ts`'s
    `roleLabelText`): a duty role renders as `Duty` / `Duty (2nd)` in the
    clinic-type position, a clinic renders as its type's name, and an
    admin-time row says `Admin`. `Session` is the last-resort label for a
    plain roomed session with no clinic type, which is the common case.
    """
    if session.role is SessionRole.DUTY_PRIMARY:
        return "Duty"
    if session.role is SessionRole.DUTY_SECONDARY:
        return "Duty (2nd)"
    if session.role is SessionRole.CLINIC:
        return clinic_name or "Clinic"
    if clinic_name:
        return clinic_name
    if session.template_type is MasterSessionType.ADMIN_TIME:
        return "Admin"
    return "Session"


def _summary(session: RotaSession, room_code: str | None, clinic_name: str | None) -> str:
    activity = _activity_label(session, clinic_name)
    if session.is_wfh:
        # A WFH row has no room to be in, whatever the row happens to carry.
        return f"WFH: {activity}"
    if room_code:
        return f"{room_code} — {activity}"
    return activity


def _description(doctor: Doctor, session: RotaSession) -> str:
    parts = [doctor.code]
    if session.is_supervising:
        parts.append("Supervising")
    if session.notes and session.notes.strip():
        parts.append(session.notes.strip())
    return "\n".join(parts)


def _utc(day: datetime.date, at: datetime.time) -> datetime.datetime:
    """A naive practice-local wall time as an aware UTC datetime."""
    local = datetime.datetime.combine(day, at).replace(tzinfo=PRACTICE_TZ)
    return local.astimezone(datetime.timezone.utc)


def _timed_event(
    uid: str,
    summary: str,
    day: datetime.date,
    period: Period,
    stamp: datetime.datetime,
    description: str | None = None,
    location: str | None = None,
) -> Event:
    start, end = PERIOD_TIMES[period]
    event = Event()
    event.add("uid", uid)
    event.add("dtstamp", stamp)
    event.add("dtstart", _utc(day, start))
    event.add("dtend", _utc(day, end))
    event.add("summary", summary)
    if description:
        event.add("description", description)
    if location:
        event.add("location", location)
    event.add("transp", "OPAQUE")
    return event


def build_feed(db: Session, doctor: Doctor, today: datetime.date) -> bytes:
    """Render this doctor's committed sessions as iCalendar bytes.

    `today` is a parameter rather than `date.today()` so the rolling history
    window is testable without freezing the clock.
    """
    window_start = today - datetime.timedelta(days=HISTORY_DAYS)
    stamp = datetime.datetime.now(datetime.timezone.utc)

    calendar = Calendar()
    calendar.add("prodid", "-//Rota//Calendar Feed//EN")
    calendar.add("version", "2.0")
    calendar.add("calscale", "GREGORIAN")
    calendar.add("method", "PUBLISH")
    calendar.add("x-wr-calname", f"{doctor.code} rota")
    calendar.add("x-wr-timezone", PRACTICE_TZ_NAME)
    # Two spellings of the same 12 hours: RFC 7986's REFRESH-INTERVAL and the
    # older X-PUBLISHED-TTL. The first is a real DURATION property, so it is
    # added as a timedelta; the second is an X- property icalendar has no type
    # for, so it has to be handed the pre-formatted string.
    calendar.add(
        "refresh-interval", REFRESH_INTERVAL, parameters={"VALUE": "DURATION"}
    )
    calendar.add("x-published-ttl", REFRESH_INTERVAL_TEXT)

    # Committed rotas and their configs. The window is applied to the rota
    # range rather than per session, so a rota that ended before the cutoff is
    # never queried for sessions at all. The range-end filter is done in
    # Python because `start_date + num_weeks * 7 days` is not portable date
    # arithmetic across SQLite and Postgres, and the committed-rota count is a
    # handful of rows.
    rows = db.execute(
        select(GeneratedRota, RotaConfig)
        .join(RotaConfig, GeneratedRota.config_id == RotaConfig.id)
        .where(GeneratedRota.status == RotaStatus.COMMITTED)
    ).all()
    configs = {
        rota.id: config for rota, config in rows if _rota_end_date(config) > window_start
    }
    if not configs:
        return calendar.to_ical()

    rota_ids = list(configs)
    week_dates = {
        rota_id: build_week_dates(config.start_date, config.num_weeks)
        for rota_id, config in configs.items()
    }
    latest_end = max(_rota_end_date(config) for config in configs.values())

    # Three more queries, each covering every rota at once -- four in total
    # regardless of how many rotas are in the window.
    sessions = db.execute(
        select(RotaSession, Room.code, ClinicType.name)
        .outerjoin(Room, RotaSession.room_id == Room.id)
        .outerjoin(ClinicType, RotaSession.clinic_type_id == ClinicType.id)
        .where(
            RotaSession.rota_id.in_(rota_ids),
            RotaSession.doctor_id == doctor.id,
        )
    ).all()
    closed = {
        (row.rota_id, row.date, row.period)
        for row in db.execute(
            select(RotaClosure).where(RotaClosure.rota_id.in_(rota_ids))
        ).scalars()
    }
    on_leave = {
        (row.date, row.period)
        for row in db.execute(
            select(LeaveEntry).where(
                LeaveEntry.doctor_id == doctor.id,
                LeaveEntry.date >= window_start,
                LeaveEntry.date < latest_end,
            )
        ).scalars()
    }

    # Slots the doctor would have worked but for leave, keyed by date, so a
    # date with both periods suppressed can collapse into one all-day event.
    suppressed: dict[datetime.date, list[tuple[Period, int]]] = defaultdict(list)

    for session, room_code, clinic_name in sessions:
        day = week_dates[session.rota_id].get((session.week, session.day))
        if day is None or day < window_start:
            continue
        if (session.rota_id, day, session.period) in closed:
            continue
        if session.template_type is EXCLUDED_TEMPLATE_TYPE:
            continue
        if (day, session.period) in on_leave:
            suppressed[day].append((session.period, session.id))
            continue
        calendar.add_component(
            _timed_event(
                uid=f"{session.id}@{UID_DOMAIN}",
                summary=_summary(session, room_code, clinic_name),
                day=day,
                period=session.period,
                stamp=stamp,
                description=_description(doctor, session),
                # A WFH session is not in a room even if the row carries one.
                location=None if session.is_wfh else room_code,
            )
        )

    for day, slots in suppressed.items():
        periods = {period for period, _session_id in slots}
        if periods == {Period.AM, Period.PM}:
            # RFC 5545's DTEND is exclusive for a DATE value.
            event = Event()
            event.add("uid", f"leave-{doctor.id}-{day:%Y%m%d}@{UID_DOMAIN}")
            event.add("dtstamp", stamp)
            event.add("dtstart", day)
            event.add("dtend", day + datetime.timedelta(days=1))
            event.add("summary", LEAVE_SUMMARY)
            event.add("transp", "OPAQUE")
            calendar.add_component(event)
            continue
        for period, session_id in slots:
            # A half day of leave is a real half day at work: an all-day blob
            # would misstate it, so it keeps that period's own times.
            calendar.add_component(
                _timed_event(
                    uid=f"leave-{session_id}@{UID_DOMAIN}",
                    summary=f"{LEAVE_SUMMARY} ({period.value})",
                    day=day,
                    period=period,
                    stamp=stamp,
                )
            )

    return calendar.to_ical()
