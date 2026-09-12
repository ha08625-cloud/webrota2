"""Enumerations shared across the data layer.

These are plain Python str-enums. `enum_col()` wraps one for use as a SQLAlchemy
column type, storing the enum *value* (e.g. "Partner", "AM", "shared") rather
than the member name, so the database holds the documented strings.
"""
import enum
import re

from sqlalchemy import Enum as SAEnum


class DoctorType(str, enum.Enum):
    PARTNER = "Partner"
    SALARIED = "Salaried"
    TRAINEE = "Trainee"
    LOCUM = "Locum"
    AHP = "AHP"


class SupervisionPreference(str, enum.Enum):
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