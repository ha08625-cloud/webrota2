import { describe, expect, it } from "vitest";

import type { UndoEntry } from "@/lib/undoStack";

import { buildReplayRequest } from "./replayUndo";

describe("buildReplayRequest", () => {
  it("maps a swap-roles entry to a single swap-roles replay with the same two session ids", () => {
    const entry: UndoEntry = { kind: "swap-roles", sessionAId: 10, sessionBId: 20 };

    expect(buildReplayRequest(entry, 7)).toEqual([
      { kind: "swap-roles", payload: { rotaId: 7, sessionAId: 10, sessionBId: 20 } },
    ]);
  });

  it("maps a swap-rooms entry to a single swap-rooms replay with the same two session ids", () => {
    const entry: UndoEntry = { kind: "swap-rooms", sessionAId: 11, sessionBId: 21 };

    expect(buildReplayRequest(entry, 7)).toEqual([
      { kind: "swap-rooms", payload: { rotaId: 7, sessionAId: 11, sessionBId: 21 } },
    ]);
  });

  it("maps a patch entry to a single patch replay carrying the previous values, not the current ones", () => {
    const entry: UndoEntry = {
      kind: "patch",
      sessionId: 42,
      previousIsWfh: false,
      previousNotes: "on call",
      previousIsSupervising: true,
      previousRoomId: 3,
      previousRoomCode: "D1",
    };

    expect(buildReplayRequest(entry, 7)).toEqual([
      {
        kind: "patch",
        payload: { rotaId: 7, sessionId: 42, isWfh: false, notes: "on call", isSupervising: true },
      },
    ]);
  });

  it("patch replay carries null notes through as null, not omitted", () => {
    const entry: UndoEntry = {
      kind: "patch",
      sessionId: 42,
      previousIsWfh: true,
      previousNotes: null,
      previousIsSupervising: false,
      previousRoomId: null,
      previousRoomCode: null,
    };

    expect(buildReplayRequest(entry, 7)).toEqual([
      {
        kind: "patch",
        payload: { rotaId: 7, sessionId: 42, isWfh: true, notes: null, isSupervising: false },
      },
    ]);
  });

  // --- set-room (M4.1 Task 2) ---

  it("set-room with no displaced and no WFH: a single set-room restoring the previous room", () => {
    const entry: UndoEntry = {
      kind: "set-room",
      sessionId: 42,
      previousRoomId: 3,
      previousIsWfh: false,
      previousNotes: null,
      displaced: null,
    };

    expect(buildReplayRequest(entry, 7)).toEqual([
      { kind: "set-room", payload: { rotaId: 7, sessionId: 42, roomId: 3 } },
    ]);
  });

  it("set-room with a displaced session: restores the displaced session's room first, then the target's", () => {
    const entry: UndoEntry = {
      kind: "set-room",
      sessionId: 42,
      previousRoomId: 3,
      previousIsWfh: false,
      previousNotes: null,
      displaced: { sessionId: 99, roomId: 5 },
    };

    expect(buildReplayRequest(entry, 7)).toEqual([
      { kind: "set-room", payload: { rotaId: 7, sessionId: 99, roomId: 5 } },
      { kind: "set-room", payload: { rotaId: 7, sessionId: 42, roomId: 3 } },
    ]);
  });

  it("set-room with previousIsWfh true: restores via PATCH, no set-room call for the target", () => {
    const entry: UndoEntry = {
      kind: "set-room",
      sessionId: 42,
      previousRoomId: null,
      previousIsWfh: true,
      previousNotes: "was WFH",
      displaced: null,
    };

    expect(buildReplayRequest(entry, 7)).toEqual([
      { kind: "patch", payload: { rotaId: 7, sessionId: 42, isWfh: true, notes: "was WFH" } },
    ]);
  });

  // --- set-role (M4.1 Task 2) ---

  it("set-role with no displaced and no room clear: a single set-role restoring the previous triple", () => {
    const entry: UndoEntry = {
      kind: "set-role",
      sessionId: 42,
      previous: { role: "duty_primary", clinicTypeId: null, templateType: "requires_room", roomId: 3 },
      roomWasCleared: false,
      displaced: null,
    };

    expect(buildReplayRequest(entry, 7)).toEqual([
      {
        kind: "set-role",
        payload: {
          rotaId: 7,
          sessionId: 42,
          triple: { role: "duty_primary", clinicTypeId: null, templateType: "requires_room" },
        },
      },
    ]);
  });

  it("set-role with a displaced session: restores the displaced session first, then the target", () => {
    const entry: UndoEntry = {
      kind: "set-role",
      sessionId: 42,
      previous: { role: "clinic", clinicTypeId: 9, templateType: "requires_room", roomId: 3 },
      roomWasCleared: false,
      displaced: { sessionId: 99, role: "clinic", clinicTypeId: 9, templateType: "requires_room" },
    };

    expect(buildReplayRequest(entry, 7)).toEqual([
      {
        kind: "set-role",
        payload: {
          rotaId: 7,
          sessionId: 99,
          triple: { role: "clinic", clinicTypeId: 9, templateType: "requires_room" },
        },
      },
      {
        kind: "set-role",
        payload: {
          rotaId: 7,
          sessionId: 42,
          triple: { role: "clinic", clinicTypeId: 9, templateType: "requires_room" },
        },
      },
    ]);
  });

  it("set-role with roomWasCleared: appends a trailing set-room restoring the previous room", () => {
    const entry: UndoEntry = {
      kind: "set-role",
      sessionId: 42,
      previous: { role: "duty_primary", clinicTypeId: null, templateType: "requires_room", roomId: 3 },
      roomWasCleared: true,
      displaced: null,
    };

    expect(buildReplayRequest(entry, 7)).toEqual([
      {
        kind: "set-role",
        payload: {
          rotaId: 7,
          sessionId: 42,
          triple: { role: "duty_primary", clinicTypeId: null, templateType: "requires_room" },
        },
      },
      { kind: "set-room", payload: { rotaId: 7, sessionId: 42, roomId: 3 } },
    ]);
  });

  it("set-role with roomWasCleared but no previous room: no trailing set-room call", () => {
    const entry: UndoEntry = {
      kind: "set-role",
      sessionId: 42,
      previous: { role: null, clinicTypeId: null, templateType: "no_surgery", roomId: null },
      roomWasCleared: true,
      displaced: null,
    };

    expect(buildReplayRequest(entry, 7)).toEqual([
      {
        kind: "set-role",
        payload: {
          rotaId: 7,
          sessionId: 42,
          triple: { role: null, clinicTypeId: null, templateType: "no_surgery" },
        },
      },
    ]);
  });
});