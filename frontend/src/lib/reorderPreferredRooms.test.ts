import { describe, expect, it } from "vitest";

import { type PreferredRoomRow, moveRow, toWireRows } from "./reorderPreferredRooms";

function row(id: string, roomId: number): PreferredRoomRow {
  return { id, kind: "room", roomId };
}

describe("toWireRows", () => {
  it("emits contiguous preference_order values starting at 1, in array order", () => {
    const rows = [row("a", 1), row("b", 2), row("c", 3)];
    expect(toWireRows(rows)).toEqual([
      { preference_order: 1, room_id: 1, room_type: null },
      { preference_order: 2, room_id: 2, room_type: null },
      { preference_order: 3, room_id: 3, room_type: null },
    ]);
  });

  it("stays contiguous 1..n after a reorder (moveRow), never duplicated", () => {
    const rows = [row("a", 1), row("b", 2), row("c", 3), row("d", 4)];
    const reordered = moveRow(rows, 0, 2); // move "a" to index 2
    const wire = toWireRows(reordered);
    expect(wire.map((w) => w.preference_order)).toEqual([1, 2, 3, 4]);
    expect(new Set(wire.map((w) => w.preference_order)).size).toBe(4);
    // "a" (room_id 1) should now be third.
    expect(wire[2]).toEqual({ preference_order: 3, room_id: 1, room_type: null });
  });

  it("stays contiguous 1..n after an insert (add row)", () => {
    const rows = [row("a", 1), row("b", 2)];
    const withInsert = [...rows, row("c", 3)];
    expect(toWireRows(withInsert).map((w) => w.preference_order)).toEqual([1, 2, 3]);
  });

  it("stays contiguous 1..n after a delete (remove row), closing the gap", () => {
    const rows = [row("a", 1), row("b", 2), row("c", 3)];
    const withRemoval = rows.filter((r) => r.id !== "b");
    const wire = toWireRows(withRemoval);
    expect(wire.map((w) => w.preference_order)).toEqual([1, 2]);
    expect(wire.map((w) => w.room_id)).toEqual([1, 3]);
  });

  it("stays contiguous 1..n through a combined reorder + insert + delete sequence", () => {
    let rows = [row("a", 1), row("b", 2), row("c", 3)];
    rows = moveRow(rows, 0, 2); // b, c, a
    rows = [...rows, row("d", 4)]; // b, c, a, d
    rows = rows.filter((r) => r.id !== "c"); // b, a, d
    const wire = toWireRows(rows);
    expect(wire.map((w) => w.preference_order)).toEqual([1, 2, 3]);
    expect(new Set(wire.map((w) => w.preference_order)).size).toBe(3);
  });

  it("produces an empty payload for an empty row list", () => {
    expect(toWireRows([])).toEqual([]);
  });
});

describe("moveRow", () => {
  it("moves an item from one index to another", () => {
    const rows = [row("a", 1), row("b", 2), row("c", 3)];
    const result = moveRow(rows, 2, 0);
    expect(result.map((r) => r.id)).toEqual(["c", "a", "b"]);
  });

  it("is a no-op when fromIndex equals toIndex", () => {
    const rows = [row("a", 1), row("b", 2)];
    expect(moveRow(rows, 1, 1)).toEqual(rows);
  });

  it("clamps out-of-range indices instead of throwing", () => {
    const rows = [row("a", 1), row("b", 2)];
    expect(() => moveRow(rows, -5, 50)).not.toThrow();
  });

  it("does not mutate the input array", () => {
    const rows = [row("a", 1), row("b", 2)];
    const original = [...rows];
    moveRow(rows, 0, 1);
    expect(rows).toEqual(original);
  });
});