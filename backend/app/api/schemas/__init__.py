"""Pydantic schemas for the API."""
from .common import ValidationIssueOut
from .edit_lock import EditLockOut
from .rota import (
    GenerateRotaIn,
    GenerateRotaOut,
    GenerationLogEntryOut,
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
    ClinicTypePatch,
    ClinicTypeReorderIn,
    DoctorEligIn,
    DoctorEligOut,
    RoomEligIn,
    RoomEligOut,
    ScheduleIn,
    ScheduleOut,
)
from .doctor import (
    CalendarFeedOut,
    DoctorDeleteOut,
    DoctorDetailOut,
    DoctorIn,
    DoctorOut,
    DoctorPatch,
    DoctorUsageOut,
    PreferredRoomIn,
    PreferredRoomOut,
)
from .extra_session import ExtraSessionIn, ExtraSessionOut
from .blocked import BlockedOut
from .leave import (
    LeaveBulkDeleteIn,
    LeaveBulkDeleteOut,
    LeaveBulkIn,
    LeaveBulkOut,
    LeaveBulkSkippedOut,
    LeaveChargeableCountOut,
    LeaveExemptionsOut,
    LeaveIn,
    LeaveOut,
)
from .leave_entitlement import (
    LeaveEntitlementIn,
    LeaveEntitlementOut,
    LeaveEntitlementYearOut,
)
from .leave_planning import (
    CoverageSlotOut,
    PlanningActionIn,
    PlanningBulkIn,
    PlanningBulkOut,
    PlanningSkippedOut,
)
from .duty import DutyIn, DutyOut, DutyCountOut, DutyOpeningBalanceIn
from .closure import BankHolidayOut, BankHolidaySetIn, ClosedSlotOut, ClosureIn, ClosureOut
from .room import RoomOut
from .counter import (
    ClinicCounterOut,
    ClinicOpeningBalanceIn,
    SystemCounterOut,
    SystemOpeningBalanceIn,
)
from .master_rota import (
    MasterRotaSessionOut,
    MasterRotaTemplateOut,
    MasterSessionCreateIn,
    MasterSessionPatchIn,
    MasterSessionWriteOut,
)
from .staging import (
    StagingCreateIn,
    StagingNoteIn,
    StagingNoteOut,
    StagingNotePatchIn,
    StagingOut,
    StagingSessionCreateIn,
    StagingSessionOut,
    StagingSessionPatchIn,
    StagingSessionWriteOut,
)
from .school import SchoolHolidayIn, SchoolHolidayOut, SchoolIn, SchoolOut
from .signature import SignatureMetaOut
from .auth import (
    ForgotPasswordIn,
    LoginIn,
    LoginOut,
    PermissionSet,
    PermissionSetIn,
    ResetPasswordIn,
    StaffLinkOut,
    UserIn,
    UserOut,
    UserPatch,
    UserSelfPatch,
)
from .audit import AuditLogEntryOut, AuditLogListOut
from .recurring_note import RecurringNoteIn, RecurringNoteOut
from .reception import (
    ReceptionCounterRowOut,
    ReceptionCountersOut,
    ReceptionLeaveBulkDeleteIn,
    ReceptionLeaveBulkDeleteOut,
    ReceptionLeaveBulkIn,
    ReceptionLeaveBulkOut,
    ReceptionLeaveIn,
    ReceptionLeaveOut,
    ReceptionMasterSessionCreateIn,
    ReceptionMasterSessionOut,
    ReceptionMasterSessionPatchIn,
    ReceptionRotaGenerateIn,
    ReceptionRotaOut,
    ReceptionRotaSessionIn,
    ReceptionRotaSessionOut,
    ReceptionRotaSessionPatchIn,
    ReceptionSessionWriteOut,
    ReceptionStaffDeletedCounts,
    ReceptionStaffDeleteOut,
    ReceptionStaffIn,
    ReceptionStaffOut,
    ReceptionStaffPatch,
    ReceptionStaffUsageOut,
)

__all__ = [
    "ValidationIssueOut",
    "GenerateRotaIn", "GenerateRotaOut", "GenerationLogEntryOut", "RotaOut", "RotaSessionOut",
    "RotaSummaryOut", "SessionPatchIn", "SessionPatchOut",
    "SwapIn", "SwapOut", "SetRoomIn", "SetRoomOut", "SetRoleIn", "SetRoleOut",
    "ClinicTypeIn", "ClinicTypeOut", "ClinicTypePatch", "ClinicTypeReorderIn", "DoctorEligIn", "DoctorEligOut",
    "RoomEligIn", "RoomEligOut", "ScheduleIn", "ScheduleOut",
    "CalendarFeedOut",
    "DoctorDetailOut", "DoctorIn", "DoctorOut", "DoctorPatch",
    "DoctorUsageOut", "DoctorDeleteOut",
    "PreferredRoomIn", "PreferredRoomOut",
    "ExtraSessionIn", "ExtraSessionOut", "BlockedOut",
    "LeaveIn", "LeaveOut",
    "LeaveEntitlementIn", "LeaveEntitlementOut", "LeaveEntitlementYearOut",
    "LeaveBulkIn", "LeaveBulkOut", "LeaveBulkSkippedOut",
    "LeaveBulkDeleteIn", "LeaveBulkDeleteOut",
    "LeaveChargeableCountOut", "LeaveExemptionsOut",
    "CoverageSlotOut", "PlanningActionIn", "PlanningBulkIn", "PlanningBulkOut",
    "PlanningSkippedOut",
    "DutyIn", "DutyOut", "DutyCountOut", "DutyOpeningBalanceIn",
    "ClosureIn", "ClosureOut", "ClosedSlotOut", "BankHolidayOut", "BankHolidaySetIn",
    "RoomOut", "ClinicCounterOut", "SystemCounterOut",
    "ClinicOpeningBalanceIn", "SystemOpeningBalanceIn",
    "MasterRotaSessionOut", "MasterRotaTemplateOut",
    "MasterSessionPatchIn", "MasterSessionCreateIn", "MasterSessionWriteOut",
    "StagingCreateIn", "StagingOut", "StagingSessionOut",
    "StagingSessionPatchIn", "StagingSessionCreateIn", "StagingSessionWriteOut",
    "StagingNoteIn", "StagingNotePatchIn", "StagingNoteOut",
    "SignatureMetaOut",
    "SchoolIn", "SchoolOut", "SchoolHolidayIn", "SchoolHolidayOut",
    "LoginIn", "LoginOut", "PermissionSet", "PermissionSetIn",
    "ForgotPasswordIn", "ResetPasswordIn",
    "StaffLinkOut", "UserOut", "UserIn", "UserPatch",
    "UserSelfPatch",
    "AuditLogEntryOut", "AuditLogListOut",
    "RecurringNoteIn", "RecurringNoteOut",
    "ReceptionStaffIn", "ReceptionStaffOut", "ReceptionStaffPatch",
    "ReceptionStaffUsageOut", "ReceptionStaffDeleteOut",
    "ReceptionStaffDeletedCounts",
    "ReceptionMasterSessionOut", "ReceptionMasterSessionCreateIn",
    "ReceptionMasterSessionPatchIn",
    "ReceptionRotaGenerateIn", "ReceptionRotaOut", "ReceptionRotaSessionIn",
    "ReceptionRotaSessionOut", "ReceptionRotaSessionPatchIn",
    "ReceptionSessionWriteOut",
    "ReceptionLeaveIn", "ReceptionLeaveOut", "ReceptionLeaveBulkIn",
    "ReceptionLeaveBulkOut", "ReceptionLeaveBulkDeleteIn",
    "ReceptionLeaveBulkDeleteOut",
    "ReceptionCounterRowOut", "ReceptionCountersOut",
    "EditLockOut",
]