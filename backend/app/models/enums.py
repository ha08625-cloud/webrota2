"""Enumerations shared across the data layer.

These are plain Python str-enums. `enum_col()` wraps one for use as a SQLAlchemy
column type, storing the enum *value* (e.g. "Partner", "AM", "shared") rather
than the member name, so the database holds the documented strings.
"""
import enum
import re

from sqlalchemy import Enum as SAEnum


class DoctorType(str, enum.Enum):
    """The staff types the clinical rota allocates.

    Despite the name, not every member is a doctor: AHP and NURSE are
    clinical staff who occupy rooms and sessions the same way. NURSE has no
    leave entitlement and is *inert* to the generation engine: a nurse's
    room is decided by a human on the master rota, Phase 2 copies it into
    the grid, and no phase then reads a nurse as demand or writes to their
    slot. Their room is an ordinary occupied room to everybody else. See
    `engine/phases/_shared.is_inert` for the full rule.
    """

    PARTNER = "Partner"
    SALARIED = "Salaried"
    TRAINEE = "Trainee"
    LOCUM = "Locum"
    AHP = "AHP"
    NURSE = "Nurse"


class PreferenceWeight(str, enum.Enum):
    """How strongly a doctor wants something the engine allocates by fairness.

    Shared by `Doctor.supervision_preference` and `Doctor.wfh_preference`:
    both feed the same `PREFERENCE_MULTIPLIERS` table and both
    read the same way under lowest-score-wins selection, whether the thing
    being allocated is a burden (supervision) or a perk (WFH).
    """

    NONE = "none"
    LESS = "less"
    NORMAL = "normal"
    MORE = "more"


class RoomType(str, enum.Enum):
    D = "D"
    C = "C"
    W = "W"
    SR = "SR"


class Site(str, enum.Enum):
    SHC = "SHC"
    CUTTESLOWE = "Cutteslowe"
    WOLVERCOTE = "Wolvercote"


class Day(str, enum.Enum):
    MONDAY = "Monday"
    TUESDAY = "Tuesday"
    WEDNESDAY = "Wednesday"
    THURSDAY = "Thursday"
    FRIDAY = "Friday"


# Monday..Friday offsets in days from the week's Monday. Callers rely on the
# dict's insertion order (Monday..Friday) as well as on the offsets themselves.
DAY_ORDER: dict[Day, int] = {
    Day.MONDAY: 0,
    Day.TUESDAY: 1,
    Day.WEDNESDAY: 2,
    Day.THURSDAY: 3,
    Day.FRIDAY: 4,
}


class Period(str, enum.Enum):
    AM = "AM"
    PM = "PM"


class DutyType(str, enum.Enum):
    PRIMARY = "primary"
    SECONDARY = "secondary"


class RotaStatus(str, enum.Enum):
    DRAFT = "draft"
    COMMITTED = "committed"


class SystemCounterType(str, enum.Enum):
    ROOM_MOVE = "room_move"
    SUPERVISION = "supervision"
    WFH = "wfh"


class MasterSessionType(str, enum.Enum):
    REQUIRES_ROOM = "requires_room"
    NO_SURGERY = "no_surgery"
    ADMIN_TIME = "admin_time"
    PRE_ASSIGNED = "pre_assigned"
    WFH = "wfh"


class SessionRole(str, enum.Enum):
    DUTY_PRIMARY = "duty_primary"
    DUTY_SECONDARY = "duty_secondary"
    CLINIC = "clinic"


class ReceptionRole(str, enum.Enum):
    PHONES = "phones"
    PRESCRIPTIONS = "prescriptions"
    REGISTRATIONS = "registrations"
    FRONT_DESK = "front_desk"
    ADMIN = "admin"
    ONLINE_TRIAGE = "online_triage"
    ROTAS = "rotas"
    TASKS = "tasks"
    LUNCH = "lunch"
    NOT_WORKING = "not_working"
    OTHER = "other"
    CUTTESLOWE = "cutteslowe"
    WOLVERCOTE = "wolvercote"


class StudyStage(str, enum.Enum):
    """The one stage a research study is in (see app/research/).

    Mutually exclusive by construction: one column holding one of these
    four values, never four booleans, so "recruitment open and closed at
    once" is a state the schema cannot hold.
    """

    SETUP = "setup"
    RECRUITMENT_OPEN = "recruitment_open"
    RECRUITMENT_CLOSED = "recruitment_closed"
    CLOSED = "closed"


# The stages in order. Transitions are one step along this tuple in either
# direction and are *derived* from it -- nothing anywhere writes out "the
# stage after recruitment_open", so adding a fifth stage is an edit here and
# a migration, not a hunt through call sites.
STUDY_STAGE_ORDER: tuple[StudyStage, ...] = (
    StudyStage.SETUP,
    StudyStage.RECRUITMENT_OPEN,
    StudyStage.RECRUITMENT_CLOSED,
    StudyStage.CLOSED,
)


class AccessLevel(str, enum.Enum):
    """Permission tier on User.

    Named access_level rather than role because the rota domain already owns
    "role" (session roles, /rota/{id}/swap-roles, SetRoleOut). MANAGER and
    ADMIN are distinct tiers; DOCTOR and NURSE are permission-identical
    labels and are not linked to any Doctor or ReceptionStaff row.
    """

    MANAGER = "manager"
    ADMIN = "admin"
    DOCTOR = "doctor"
    NURSE = "nurse"


def _snake(name: str) -> str:
    return re.sub(r"(?<!^)(?=[A-Z])", "_", name).lower()


_ENUM_TYPE_CACHE: dict[type[enum.Enum], SAEnum] = {}


def enum_col(py_enum: type[enum.Enum]) -> SAEnum:
    """Build (or reuse) the SQLAlchemy Enum column type for a Python enum.

    Stores the enum *value* and uses a stable lowercase type name. The
    instance is cached and shared across every column that uses the same
    Python enum: on Postgres, a native ``CREATE TYPE`` is emitted per enum
    type, and a fresh SAEnum instance per column would try to create the
    same named type once per table, breaking ``create_all`` /
    ``alembic upgrade head``. One shared instance per enum lets SQLAlchemy
    deduplicate type creation within Base.metadata. SQLite is unaffected
    (renders VARCHAR + CHECK).
    """
    cached = _ENUM_TYPE_CACHE.get(py_enum)
    if cached is None:
        cached = SAEnum(
            py_enum,
            name=_snake(py_enum.__name__),
            values_callable=lambda e: [member.value for member in e],
        )
        _ENUM_TYPE_CACHE[py_enum] = cached
    return cached