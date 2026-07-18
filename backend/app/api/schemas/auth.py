"""Auth schemas. UserOut never includes password_hash."""
import datetime

from pydantic import BaseModel, Field


class LoginIn(BaseModel):
    email: str = Field(min_length=1)
    password: str = Field(min_length=1, max_length=72)


class UserOut(BaseModel):
    id: int
    email: str
    name: str
    active: bool
    created_at: datetime.datetime
    model_config = {"from_attributes": True}


class LoginOut(BaseModel):
    token: str
    user: UserOut
