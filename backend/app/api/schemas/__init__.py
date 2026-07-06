"""Pydantic schemas for the M3 API."""
from .common import ValidationIssueOut
from .rota import (
    GenerateRotaIn,
    GenerateRotaOut,
    RotaOut,
    RotaSessionOut,
    RotaSummaryOut,
    SwapIn,
    SwapOut,
)
from .clinic_type import (
    ClinicTypeIn,
    ClinicTypeOut,
    DoctorEligIn,
    DoctorEligOut,
    RoomEligIn,
    RoomEligOut,
    ScheduleIn,
    ScheduleOut,
)
from .doctor import (
    DoctorDetailOut,
    DoctorIn,
    DoctorOut,
    DoctorPatch,
    PreferredRoomIn,
    PreferredRoomOut,
)
from .leave import LeaveIn, LeaveOut
from .duty import DutyIn, DutyOut
from .room import RoomOut
from .counter import ClinicCounterOut, SystemCounterOut

__all__ = [
    "ValidationIssueOut",
    "GenerateRotaIn", "GenerateRotaOut", "RotaOut", "RotaSessionOut",
    "RotaSummaryOut",
    "SwapIn", "SwapOut",
    "ClinicTypeIn", "ClinicTypeOut", "DoctorEligIn", "DoctorEligOut",
    "RoomEligIn", "RoomEligOut", "ScheduleIn", "ScheduleOut",
    "DoctorDetailOut", "DoctorIn", "DoctorOut", "DoctorPatch",
    "PreferredRoomIn", "PreferredRoomOut",
    "LeaveIn", "LeaveOut", "DutyIn", "DutyOut",
    "RoomOut", "ClinicCounterOut", "SystemCounterOut",
]