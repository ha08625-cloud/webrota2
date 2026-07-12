import { describe, expect, it } from "vitest";

import {
  buildMasterReplaySteps,
  masterMutationAppliedMessage,
  masterSessionCreatedMessage,
  masterSessionDeletedMessage,
  type MasterUndoEntry,
} from "./masterUndo";

describe("buildMasterReplaySteps: kind patch", () => {
  it("builds a single patch step when there was no displaced session", () => {
    const entry: MasterUndoEntry = {
      kind: "patch",
      sessionId: 1,
      previous: { sessionType: "requires_room", roomId: null },
      displaced: null,
    };

    expect(buildMasterReplaySteps(entry)).toEqual([
      { op: "patch", sessionId: 1, sessionType: "requires_room", roomId: null },
    ]);
  });

  it("orders the displaced session's patch before the target's own patch", () => {
    const entry: MasterUndoEntry = {
      kind: "patch",
      sessionId: 1,
      previous: { sessionType: "requires_room", roomId: null },
      displaced: { sessionId: 2, sessionType: "pre_assigned", roomId: 5 },
    };

    expect(buildMasterReplaySteps(entry)).toEqual([
      { op: "patch", sessionId: 2, sessionType: "pre_assigned", roomId: 5 },
      { op: "patch", sessionId: 1, sessionType: "requires_room", roomId: null },
    ]);
  });
});

describe("buildMasterReplaySteps: kind create", () => {
  it("builds a single delete step when there was no displaced session", () => {
    const entry: MasterUndoEntry = {
      kind: "create",
      createdSessionId: 99,
      displaced: null,
    };

    expect(buildMasterReplaySteps(entry)).toEqual([{ op: "delete", sessionId: 99 }]);
  });

  it("orders the displaced session's patch before deleting the created session", () => {
    const entry: MasterUndoEntry = {
      kind: "create",
      createdSessionId: 99,
      displaced: { sessionId: 2, sessionType: "pre_assigned", roomId: 5 },
    };

    expect(buildMasterReplaySteps(entry)).toEqual([
      { op: "patch", sessionId: 2, sessionType: "pre_assigned", roomId: 5 },
      { op: "delete", sessionId: 99 },
    ]);
  });
});

describe("buildMasterReplaySteps: kind delete", () => {
  it("builds a single create step at the original slot with the previous pair", () => {
    const entry: MasterUndoEntry = {
      kind: "delete",
      doctorId: 1,
      week: 2,
      day: "Tuesday",
      period: "PM",
      previous: { sessionType: "pre_assigned", roomId: 5 },
    };

    expect(buildMasterReplaySteps(entry)).toEqual([
      {
        op: "create",
        doctorId: 1, week: 2, day: "Tuesday", period: "PM",
        sessionType: "pre_assigned", roomId: 5,
      },
    ]);
  });

  it("has no displaced-restore step - a plain removal never displaces anything", () => {
    const entry: MasterUndoEntry = {
      kind: "delete",
      doctorId: 1,
      week: 1,
      day: "Monday",
      period: "AM",
      previous: { sessionType: "no_surgery", roomId: null },
    };

    expect(buildMasterReplaySteps(entry)).toHaveLength(1);
  });
});

describe("masterMutationAppliedMessage", () => {
  it("includes the room code when one was assigned", () => {
    expect(masterMutationAppliedMessage("AB", "Monday", "AM", "pre_assigned", "D1")).toBe(
      "AB Monday AM set to Pre-assigned D1",
    );
  });

  it("omits the room when there isn't one", () => {
    expect(masterMutationAppliedMessage("AB", "Monday", "AM", "no_surgery", null)).toBe(
      "AB Monday AM set to No surgery",
    );
  });
});

describe("masterSessionCreatedMessage", () => {
  it("includes the room code when one was assigned", () => {
    expect(masterSessionCreatedMessage("AB", "Monday", "AM", "pre_assigned", "D1")).toBe(
      "AB Monday AM session added (Pre-assigned D1)",
    );
  });

  it("omits the room when there isn't one", () => {
    expect(masterSessionCreatedMessage("AB", "Monday", "AM", "no_surgery", null)).toBe(
      "AB Monday AM session added (No surgery)",
    );
  });
});

describe("masterSessionDeletedMessage", () => {
  it("names the doctor, day, and period", () => {
    expect(masterSessionDeletedMessage("AB", "Monday", "AM")).toBe("AB Monday AM session removed");
  });
});