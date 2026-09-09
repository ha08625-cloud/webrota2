import { describe, expect, it } from "vitest";

import { makeRoom } from "@/test/fixtures/reference";
import { makeRotaSession } from "@/test/fixtures/rota";

import { compareRoomDisplayOrder, getRoomCell, pivotRoomRota, ROOM_TYPE_ORDER } from "./pivotRoomRota";

describe("pivotRoomRota", () => {
  it("orders rows by room type (D, C, W, SR) before code", () => {
    const rooms = [
      makeRoom({ id: 1, code: "SR", room_type: "SR" }),
      makeRoom({ id: 2, code: "W1", room_type: "W" }),
      makeRoom({ id: 3, code: "C1", room_type: "C" }),
      makeRoom({ id: 4, code: "D1", room_type: "D" }),
    ];
    const grid = pivotRoomRota([], rooms);
    expect(grid.rows.map((r) => r.code)).toEqual(["D1", "C1", "W1", "SR"]);
  });

  it("alphabetises by code within a type", () => {
    const rooms = [
      makeRoom({ id: 1, code: "D8", room_type: "D" }),
      makeRoom({ id: 2, code: "D1", room_type: "D" }),
      makeRoom({ id: 3, code: "D3", room_type: "D" }),
    ];
    const grid = pivotRoomRota([], rooms);
    expect(grid.rows.map((r) => r.code)).toEqual(["D1", "D3", "D8"]);
  });

  it("orders by type over site-alphabetical - a C room never sorts before a D room even when its site would put it first", () => {
    // Site-then-code would put a Cutteslowe C-room ahead of an SHC D-room;
    // type-then-code must not.
    const rooms = [
      makeRoom({ id: 1, code: "C1", room_type: "C", site: "Cutteslowe" }),
      makeRoom({ id: 2, code: "D1", room_type: "D", site: "SHC" }),
    ];
    const grid = pivotRoomRota([], rooms);
    expect(grid.rows.map((r) => r.code)).toEqual(["D1", "C1"]);
  });

  it("covers every room type in ROOM_TYPE_ORDER", () => {
    expect(ROOM_TYPE_ORDER).toEqual(["D", "C", "W", "SR"]);
  });

  it("sorts numerically within a type via compareRoomDisplayOrder directly", () => {
    const d9 = makeRoom({ code: "D9", room_type: "D" });
    const d10 = makeRoom({ code: "D10", room_type: "D" });
    expect(compareRoomDisplayOrder(d9, d10)).toBeLessThan(0);
  });

  it("looks a session up by its exact (room, week, day, period) key", () => {
    const session = makeRotaSession({ room_id: 5, week: 2, day: "Wednesday", period: "PM" });
    const grid = pivotRoomRota([session], [makeRoom({ id: 5 })]);
    expect(getRoomCell(grid, 5, 2, "Wednesday", "PM")).toBe(session);
  });

  it("misses on a different week/day/period for the same room", () => {
    const session = makeRotaSession({ room_id: 5, week: 1, day: "Monday", period: "AM" });
    const grid = pivotRoomRota([session], [makeRoom({ id: 5 })]);
    expect(getRoomCell(grid, 5, 1, "Monday", "PM")).toBeUndefined();
    expect(getRoomCell(grid, 5, 2, "Monday", "AM")).toBeUndefined();
  });

  it("skips a session with no room - room_id: null produces no cell", () => {
    const session = makeRotaSession({ room_id: null, week: 1, day: "Monday", period: "AM" });
    const grid = pivotRoomRota([session], [makeRoom({ id: 5 })]);
    expect(getRoomCell(grid, 5, 1, "Monday", "AM")).toBeUndefined();
    expect(grid.cells.size).toBe(0);
  });

  it("still lists a room that has no sessions anywhere", () => {
    const room = makeRoom({ id: 9, code: "SR", room_type: "SR" });
    const grid = pivotRoomRota([], [room]);
    expect(grid.rows).toHaveLength(1);
    expect(grid.rows[0]).toBe(room);
  });
});
