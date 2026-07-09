import { describe, expect, it } from "vitest";

import type { UndoEntry } from "@/lib/undoStack";

import { buildReplayRequest } from "./replayUndo";

describe("buildReplayRequest", () => {
  it("maps a swap-roles entry to a swap-roles replay with the same two session ids", () => {
    const entry: UndoEntry = { kind: "swap-roles", sessionAId: 10, sessionBId: 20 };

    expect(buildReplayRequest(entry, 7)).toEqual({
      kind: "swap-roles",
      payload: { rotaId: 7, sessionAId: 10, sessionBId: 20 },
    });
  });

  it("maps a swap-rooms entry to a swap-rooms replay with the same two session ids", () => {
    const entry: UndoEntry = { kind: "swap-rooms", sessionAId: 11, sessionBId: 21 };

    expect(buildReplayRequest(entry, 7)).toEqual({
      kind: "swap-rooms",
      payload: { rotaId: 7, sessionAId: 11, sessionBId: 21 },
    });
  });

  it("maps a patch entry to a patch replay carrying the previous values, not the current ones", () => {
    const entry: UndoEntry = {
      kind: "patch",
      sessionId: 42,
      previousIsWfh: false,
      previousNotes: "on call",
      previousRoomId: 3,
      previousRoomCode: "D1",
    };

    expect(buildReplayRequest(entry, 7)).toEqual({
      kind: "patch",
      payload: { rotaId: 7, sessionId: 42, isWfh: false, notes: "on call" },
    });
  });

  it("patch replay carries null notes through as null, not omitted", () => {
    const entry: UndoEntry = {
      kind: "patch",
      sessionId: 42,
      previousIsWfh: true,
      previousNotes: null,
      previousRoomId: null,
      previousRoomCode: null,
    };

    expect(buildReplayRequest(entry, 7)).toEqual({
      kind: "patch",
      payload: { rotaId: 7, sessionId: 42, isWfh: true, notes: null },
    });
  });
});