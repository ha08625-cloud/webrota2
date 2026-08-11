"""Auth and user-management schemas. UserOut never includes password_hash.

access_level is required on UserIn rather than defaulting: creating a user
is a deliberate act of granting a permission tier, and a silent default
would make it too easy to mint managers (or, with the model's NURSE
default, to wonder why a new admin cannot write). It is optional on
UserPatch like every other patchable field.
"""
import datetime

from pydantic import BaseModel, Field

from ...models.enums import AccessLevel


class LoginIn(BaseModel):
    email: str = Field(min_length=1)
    password: str = Field(min_length=1, max_length=72)


class UserOut(BaseModel):
    id: int
    email: str
    name: str
    active: bool
    access_level: AccessLevel
    created_at: datetime.datetime
    model_config = {"from_attributes": True}


class LoginOut(BaseModel):
    token: str
    user: UserOut


class UserIn(BaseModel):
    email: str = Field(min_length=1)
    name: str = Field(min_length=1)
    password: str = Field(min_length=8, max_length=72)
    access_level: AccessLevel


class UserPatch(BaseModel):
    email: str | None = Field(default=None, min_length=1)
    name: str | None = Field(default=None, min_length=1)
    active: bool | None = None
    access_level: AccessLevel | None = None
    password: str | None = Field(default=None, min_length=8, max_length=72)


class UserSelfPatch(BaseModel):
    """Body for PATCH /users/me (role-based auth plan, Design Decision 4).

    Deliberately NOT a subset-by-inheritance of UserPatch: the fields it
    omits are the point. `access_level` is absent so the endpoint cannot be
    used for self-promotion, `active` so a user cannot deactivate
    themselves past the lock-out guard, and `email` because changing your
    own login identity is a manager action. Pydantic's default is to ignore
    unknown keys, so sending access_level here is silently dropped rather
    than applied -- that is the safe direction, and the tests pin it.
    """

    name: str | None = Field(default=None, min_length=1)
    password: str | None = Field(default=None, min_length=8, max_length=72)
