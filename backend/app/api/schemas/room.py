"""Room schemas. Rooms are read-only over the API -- there is no RoomIn."""
from pydantic import BaseModel

from ...models.enums import RoomType, Site


class RoomOut(BaseModel):
    id: int
    code: str
    room_type: RoomType
    site: Site
    model_config = {"from_attributes": True}
