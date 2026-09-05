"""Auth and user-management schemas. UserOut never includes password_hash.

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

from pydantic import BaseModel, Field

from ...models.enums import AccessLevel


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
    doctor_id: int | None = None
    reception_staff_id: int | None = None


class UserPatch(BaseModel):
    email: str | None = Field(default=None, min_length=1)
    name: str | None = Field(default=None, min_length=1)
    active: bool | None = None
    access_level: AccessLevel | None = None
    password: str | None = Field(default=None, min_length=8, max_length=72)
    doctor_id: int | None = None
    reception_staff_id: int | None = None


class UserSelfPatch(BaseModel):
    """Body for PATCH /users/me.

    Deliberately NOT a subset-by-inheritance of UserPatch: the fields it
    omits are the point. `access_level` is absent so the endpoint cannot be
    used for self-promotion, `active` so a user cannot deactivate
    themselves past the lock-out guard, and `email` because changing your
    own login identity is a manager action. `doctor_id` and
    `reception_staff_id` are absent for the same reason as access_level:
    claiming a rota identity for yourself is self-promotion, and who a
    login belongs to is a manager's decision. Pydantic's default is to
    ignore unknown keys, so sending access_level or doctor_id here is
    silently dropped rather than applied -- that is the safe direction, and
    the tests pin it.
    """

    name: str | None = Field(default=None, min_length=1)
    password: str | None = Field(default=None, min_length=8, max_length=72)
