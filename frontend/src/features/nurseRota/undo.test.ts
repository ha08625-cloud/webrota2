import { describe, expect, it } from "vitest";

import { makeMasterRotaSession } from "@/test/fixtures/masterRota";

import {
  asNurseSessionType,
  buildNurseCreateUndoEntry,
  buildNurseDeleteUndoEntry,
  buildNurseReplaySteps,
  buildNursePatchUndoEntry,
  type NurseUndoEntry,
} from "./undo";

function nurseSession(overrides: Parameters<typeof makeMasterRotaSession>[0] = {}) {
  return makeMasterRotaSession({ doctor_type: "Nurse", doctor_code: "NA", ...overrides });
}

describe("asNurseSessionType", () => {
  it("passes through the three types this router accepts", () => {
    expect(asNurseSessionType("pre_assigned")).toBe("pre_assigned");
    expect(asNurseSessionType("admin_time")).toBe("admin_time");
    expect(asNurseSessionType("no_surgery")).toBe("no_surgery");
  });

  it("rejects the two the Master Rota can write to a nurse row but this one 422s", () => {
    expect(asNurseSessionType("requires_room")).toBeNull();
    expect(asNurseSessionType("wfh")).toBeNull();
  });
});

describe("buildNursePatchUndoEntry", () => {
  it("captures the pre-mutation pair", () => {
    const session = nurseSession({ session_id: 7, session_type: "admin_time", room_id: 5 });

    expect(buildNursePatchUndoEntry(session, null)).toEqual({
      kind: "patch",
      sessionId: 7,
      previous: { sessionType: "admin_time", roomId: 5 },
      displaced: null,
    });
  });

  it("captures a displaced nurse's PRE-displacement type, not what the server left behind", () => {
    const session = nurseSession({ session_id: 7, session_type: "no_surgery", room_id: null });
    const displaced = nurseSession({ session_id: 8, session_type: "pre_assigned", room_id: 5 });

    const entry = buildNursePatchUndoEntry(session, displaced);

    // The backend turns the displaced PRE_ASSIGNED into REQUIRES_ROOM.
    // The entry - and so every replay step built from it - must still say
    // pre_assigned, because REQUIRES_ROOM is exactly what this router
    // refuses.
    expect(entry?.displaced).toEqual({ sessionId: 8, sessionType: "pre_assigned", roomId: 5 });
    // Asserted over the serialised steps rather than per-field:
    // NurseReplayStep's sessionType is NurseSessionType, so a
    // `!== "requires_room"` comparison is a typecheck error rather than a
    // test. The type is the real guarantee; this pins the value that
    // actually goes on the wire.
    const steps = buildNurseReplaySteps(entry as NurseUndoEntry);
    expect(JSON.stringify(steps)).not.toContain("requires_room");
    expect(steps[0]).toEqual({ op: "patch", sessionId: 8, sessionType: "pre_assigned", roomId: 5 });
  });

  it("returns no entry when the previous state is one this router cannot write back", () => {
    // A legacy nurse row, or one the Master Rota wrote: undoing into it
    // would 422, so the page is told there is nothing to undo rather than
    // being handed a replay that must fail.
    const session = nurseSession({ session_id: 7, session_type: "requires_room", room_id: null });

    expect(buildNursePatchUndoEntry(session, null)).toBeNull();
    expect(
      buildNursePatchUndoEntry(nurseSession({ session_id: 7, session_type: "wfh" }), null),
    ).toBeNull();
  });
});

describe("buildNurseCreateUndoEntry", () => {
  it("records the created row's id and any displaced nurse", () => {
    const displaced = nurseSession({ session_id: 8, session_type: "pre_assigned", room_id: 5 });

    expect(buildNurseCreateUndoEntry(99, displaced)).toEqual({
      kind: "create",
      createdSessionId: 99,
      displaced: { sessionId: 8, sessionType: "pre_assigned", roomId: 5 },
    });
    expect(buildNurseCreateUndoEntry(99, null)).toEqual({
      kind: "create",
      createdSessionId: 99,
      displaced: null,
    });
  });
});

describe("buildNurseDeleteUndoEntry", () => {
  it("records the slot coordinates the row has to be recreated at", () => {
    const session = nurseSession({
      session_id: 7, doctor_id: 3, week: 2, day: "Thursday", period: "PM",
      session_type: "pre_assigned", room_id: 5,
    });

    expect(buildNurseDeleteUndoEntry(session)).toEqual({
      kind: "delete",
      doctorId: 3,
      week: 2,
      day: "Thursday",
      period: "PM",
      previous: { sessionType: "pre_assigned", roomId: 5 },
    });
  });

  it("returns no entry for a row whose type this router cannot recreate", () => {
    expect(buildNurseDeleteUndoEntry(nurseSession({ session_type: "requires_room" }))).toBeNull();
  });
});

describe("buildNurseReplaySteps: kind patch", () => {
  it("builds a single patch step when nothing was displaced", () => {
    const entry: NurseUndoEntry = {
      kind: "patch",
      sessionId: 1,
      previous: { sessionType: "no_surgery", roomId: null },
      displaced: null,
    };

    expect(buildNurseReplaySteps(entry)).toEqual([
      { op: "patch", sessionId: 1, sessionType: "no_surgery", roomId: null },
    ]);
  });

  it("orders the displaced nurse's patch before the target's own", () => {
    const entry: NurseUndoEntry = {
      kind: "patch",
      sessionId: 1,
      previous: { sessionType: "no_surgery", roomId: null },
      displaced: { sessionId: 2, sessionType: "pre_assigned", roomId: 5 },
    };

    expect(buildNurseReplaySteps(entry)).toEqual([
      { op: "patch", sessionId: 2, sessionType: "pre_assigned", roomId: 5 },
      { op: "patch", sessionId: 1, sessionType: "no_surgery", roomId: null },
    ]);
  });

  it("carries no templateId on any step - the router resolves the active template", () => {
    const steps = buildNurseReplaySteps({
      kind: "patch",
      sessionId: 1,
      previous: { sessionType: "admin_time", roomId: null },
      displaced: null,
    });

    expect(steps[0]).not.toHaveProperty("templateId");
  });
});

describe("buildNurseReplaySteps: kind create", () => {
  it("builds a single delete step when nothing was displaced", () => {
    expect(buildNurseReplaySteps({ kind: "create", createdSessionId: 99, displaced: null })).toEqual(
      [{ op: "delete", sessionId: 99 }],
    );
  });

  it("orders the displaced nurse's patch before deleting the created row", () => {
    expect(
      buildNurseReplaySteps({
        kind: "create",
        createdSessionId: 99,
        displaced: { sessionId: 2, sessionType: "admin_time", roomId: 5 },
      }),
    ).toEqual([
      { op: "patch", sessionId: 2, sessionType: "admin_time", roomId: 5 },
      { op: "delete", sessionId: 99 },
    ]);
  });
});

describe("buildNurseReplaySteps: kind delete", () => {
  it("recreates the row at its original slot with its previous pair", () => {
    expect(
      buildNurseReplaySteps({
        kind: "delete",
        doctorId: 3,
        week: 2,
        day: "Thursday",
        period: "PM",
        previous: { sessionType: "pre_assigned", roomId: 5 },
      }),
    ).toEqual([
      {
        op: "create",
        doctorId: 3,
        week: 2,
        day: "Thursday",
        period: "PM",
        sessionType: "pre_assigned",
        roomId: 5,
      },
    ]);
  });
});
