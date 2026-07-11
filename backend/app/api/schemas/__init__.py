"""Pydantic schemas for the M3 API."""
from .common import ValidationIssueOut
from .rota import (
    GenerateRotaIn,
    GenerateRotaOut,
    RotaOut,
    RotaSessionOut,
    RotaSummaryOut,
    SessionPatchIn,
    SessionPatchOut,
    SetRoleIn,
    SetRoleOut,
    SetRoomIn,
    SetRoomOut,
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
from .leave import (
    LeaveBulkDeleteIn,
    LeaveBulkDeleteOut,
    LeaveBulkIn,
    LeaveBulkOut,
    LeaveBulkSkippedOut,
    LeaveIn,
    LeaveOut,
)
from .duty import DutyIn, DutyOut
from .room import RoomOut
from .counter import ClinicCounterOut, SystemCounterOut
from .master_rota import (
    MasterRotaSessionOut,
    MasterRotaTemplateOut,
    MasterSessionCreateIn,
    MasterSessionPatchIn,
    MasterSessionWriteOut,
)

__all__ = [
    "ValidationIssueOut",
    "GenerateRotaIn", "GenerateRotaOut", "RotaOut", "RotaSessionOut",
    "RotaSummaryOut", "SessionPatchIn", "SessionPatchOut",
    "SwapIn", "SwapOut", "SetRoomIn", "SetRoomOut", "SetRoleIn", "SetRoleOut",
    "ClinicTypeIn", "ClinicTypeOut", "DoctorEligIn", "DoctorEligOut",
    "RoomEligIn", "RoomEligOut", "ScheduleIn", "ScheduleOut",
    "DoctorDetailOut", "DoctorIn", "DoctorOut", "DoctorPatch",
    "PreferredRoomIn", "PreferredRoomOut",
    "LeaveIn", "LeaveOut",
    "LeaveBulkIn", "LeaveBulkOut", "LeaveBulkSkippedOut",
    "LeaveBulkDeleteIn", "LeaveBulkDeleteOut",
    "DutyIn", "DutyOut",
    "RoomOut", "ClinicCounterOut", "SystemCounterOut",
    "MasterRotaSessionOut", "MasterRotaTemplateOut",
    "MasterSessionPatchIn", "MasterSessionCreateIn", "MasterSessionWriteOut",
]