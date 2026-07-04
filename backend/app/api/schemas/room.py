"""Room schemas. Rooms are read-only in M3."""
from pydantic import BaseModel

from ...models.enums import RoomType, Site


class RoomOut(BaseModel):
    id: int
    code: str
    room_type: RoomType
    site: Site
    model_config = {"from_attributes": True}
