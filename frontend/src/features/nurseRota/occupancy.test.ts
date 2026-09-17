import { describe, expect, it } from "vitest";

import type { NurseSlotOccupancy } from "./types";
import { findSlotHolder } from "./occupancy";

function makeOccupancy(overrides: Partial<NurseSlotOccupancy> = {}): NurseSlotOccupancy {
  return {
    week: 1,
    day: "Monday",
    period: "AM",
    room_id: 5,
    room_code: "D1",
    doctor_code: "AB",
    ...overrides,
  };
}

describe("findSlotHolder", () => {
  it("names the holder of a room in the matching slot", () => {
    expect(findSlotHolder([makeOccupancy()], 1, "Monday", "AM", 5)).toBe("AB");
  });

  it("returns null for a room nobody holds in that slot", () => {
    expect(findSlotHolder([makeOccupancy()], 1, "Monday", "AM", 6)).toBeNull();
  });

  it("matches on the whole slot, not the room alone", () => {
    const occupancy = [makeOccupancy()];

    expect(findSlotHolder(occupancy, 2, "Monday", "AM", 5)).toBeNull();
    expect(findSlotHolder(occupancy, 1, "Tuesday", "AM", 5)).toBeNull();
    expect(findSlotHolder(occupancy, 1, "Monday", "PM", 5)).toBeNull();
  });
});
