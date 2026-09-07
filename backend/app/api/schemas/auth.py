"""Auth and user-management schemas. UserOut never includes password_hash.

`permissions` (PermissionSet) is the per-user permission set -- see
models/permissions.py for what the five permissions mean. It is required
on UserIn and optional on UserPatch, exactly like access_level, and
deliberately ABSENT from UserSelfPatch: nobody edits their own
permissions, for the same reason nobody sets their own access level.

Within the set, each field defaults to denied, so a body that omits a
permission grants nothing rather than inheriting something. What is
refused outright is the set that grants NOTHING: it is never what anyone
means, and "no access" is spelled `active: false`. The check
lives on the write shape (PermissionSetIn) so POST /users and PATCH
/users/{id} both 422 without either router knowing about it, and the
frontend mirrors it with the same message. It is deliberately NOT on the
read shape -- see PermissionSet's docstring.

access_level is required on UserIn rather than defaulting: creating a user
is a deliberate act of granting a permission tier, and a silent default
would make it too easy to mint managers (or, with the model's NURSE
default, to wonder why a new admin cannot write). It is optional on
UserPatch like every other patchable field.

UserOut carries the optional staff link (models/user.py) as two nested
StaffLinkOut objects. The names differ from the ORM relationships
(`doctor` / `reception_staff`), so each field reads its attribute through
a validation_alias and is emitted under its own serialization_alias: the
wire names say `linked_` because "a user's doctor" reads like ownership of
a doctor, while the ORM names stay the plain relationship names the model
gives them. Both are absent-tolerant -- a caller-supplied object without
those attributes (the test stub user) validates to None rather than
erroring.

The nested object carries `active` so a client can render "AB (inactive)"
without a second request. A link to a soft-deleted doctor is a real,
supported state: deactivating a doctor never clears the link, because
silently clearing it would lose the record of whose login that was.
"""
import datetime

from pydantic import BaseModel, Field, model_validator

from ...models.enums import AccessLevel
from ...models.permissions import (
    EMPTY_PERMISSIONS_MESSAGE,
    AccessArea,
    is_empty,
)


class PermissionSet(BaseModel):
    """What a login may do: the wire shape of the permission set.

    Two levelled areas and three flags. Each field defaults to denied so an
    incomplete body under-grants rather than over-grants.

    This is the READ shape and it has no non-empty rule. The deny-everything
    set is not a legal thing to save, but it IS a legal thing to find in the
    database -- it is the column's server_default, so any row inserted
    outside the app has it. Validating it on the way out would turn one such
    row into a 500 for the whole user list, which is the worst possible
    response to "someone ran an INSERT by hand". PermissionSetIn below is
    the write shape that refuses it.
    """

    clinical: AccessArea = "none"
    reception: AccessArea = "none"
    signatures: bool = False
    study_eoi: bool = False
    user_admin: bool = False

    model_config = {"from_attributes": True}


class PermissionSetIn(PermissionSet):
    """The write shape: a permission set that grants something.

    Inherited by both POST /users and PATCH /users/{id}, so neither router
    has to know the rule. The message is written to be shown to the user
    verbatim, and the frontend mirrors it with the same text.
    """

    @model_validator(mode="after")
    def _reject_empty(self) -> "PermissionSetIn":
        if is_empty(self.model_dump()):
            raise ValueError(EMPTY_PERMISSIONS_MESSAGE)
        return self


class LoginIn(BaseModel):
    email: str = Field(min_length=1)
    password: str = Field(min_length=1, max_length=72)


class StaffLinkOut(BaseModel):
    """The staff row a login is linked to. `active` is included so an
    inactive link can be shown as such -- see the module docstring."""

    id: int
    code: str
    active: bool
    model_config = {"from_attributes": True}


class UserOut(BaseModel):
    id: int
    email: str
    name: str
    active: bool
    access_level: AccessLevel
    permissions: PermissionSet
    linked_doctor: StaffLinkOut | None = Field(
        default=None,
        validation_alias="doctor",
        serialization_alias="linked_doctor",
    )
    linked_reception_staff: StaffLinkOut | None = Field(
        default=None,
        validation_alias="reception_staff",
        serialization_alias="linked_reception_staff",
    )
    created_at: datetime.datetime
    model_config = {"from_attributes": True, "populate_by_name": True}


class LoginOut(BaseModel):
    token: str
    user: UserOut


class UserIn(BaseModel):
    email: str = Field(min_length=1)
    name: str = Field(min_length=1)
    password: str = Field(min_length=8, max_length=72)
    access_level: AccessLevel
    permissions: PermissionSetIn
    doctor_id: int | None = None
    reception_staff_id: int | None = None


class UserPatch(BaseModel):
    email: str | None = Field(default=None, min_length=1)
    name: str | None = Field(default=None, min_length=1)
    active: bool | None = None
    access_level: AccessLevel | None = None
    permissions: PermissionSetIn | None = None
    password: str | None = Field(default=None, min_length=8, max_length=72)
    doctor_id: int | None = None
    reception_staff_id: int | None = None


class UserSelfPatch(BaseModel):
    """Body for PATCH /users/me.

    Deliberately NOT a subset-by-inheritance of UserPatch: the fields it
    omits are the point. `access_level` is absent so the endpoint cannot be
    used for self-promotion, `permissions` for the same reason and more
    directly, `active` so a user cannot deactivate themselves past the
    lock-out guard, and `email` because changing your own login identity is
    a manager action. `doctor_id` and
    `reception_staff_id` are absent for the same reason as access_level:
    claiming a rota identity for yourself is self-promotion, and who a
    login belongs to is a manager's decision. Pydantic's default is to
    ignore unknown keys, so sending access_level or doctor_id here is
    silently dropped rather than applied -- that is the safe direction, and
    the tests pin it.
    """

    name: str | None = Field(default=None, min_length=1)
    password: str | None = Field(default=None, min_length=8, max_length=72)


class ForgotPasswordIn(BaseModel):
    """Body for POST /auth/forgot-password.

    The address is matched exactly, the way login matches it: normalising
    here and not there would let an address request a reset it could never
    log in with. The endpoint answers 204 whatever happens, so a typo is
    indistinguishable from success -- which is why the forget form's copy
    has to tell the user to enter the address they log in with.
    """

    email: str = Field(min_length=1)


class ResetPasswordIn(BaseModel):
    """Body for POST /auth/reset-password.

    The token travels in the BODY, never in the path: api/audit.py redacts
    `token` out of captured request bodies but records the path verbatim,
    and a token in the URL would also reach Railway's access logs.

    The password constraint matches UserIn/UserPatch. The 72-byte cap is
    bcrypt's silent truncation point, not a style choice.
    """

    token: str = Field(min_length=1)
    password: str = Field(min_length=8, max_length=72)
