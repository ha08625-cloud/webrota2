import { describe, expect, it } from "vitest";

import { makeRotaSession } from "@/test/fixtures/rota";

import { resolveDragOutcome } from "./resolveDrag";

describe("resolveDragOutcome", () => {
  it("returns null when there is no active chip", () => {
    const over = { session: makeRotaSession() };
    expect(resolveDragOutcome(undefined, over)).toBeNull();
  });

  it("returns null when there is no drop target", () => {
    const active = { type: "role" as const, session: makeRotaSession() };
    expect(resolveDragOutcome(active, undefined)).toBeNull();
  });

  it("returns null for a self-drop (same session on both sides)", () => {
    const session = makeRotaSession({ session_id: 5, day: "Monday", period: "AM" });
    const active = { type: "role" as const, session };
    const over = { session };
    expect(resolveDragOutcome(active, over)).toBeNull();
  });

  it("returns null when the target fails the eligibility rules (different day)", () => {
    const source = makeRotaSession({ session_id: 1, day: "Monday", period: "AM" });
    const target = makeRotaSession({ session_id: 2, day: "Tuesday", period: "AM" });
    const active = { type: "role" as const, session: source };
    const over = { session: target };
    expect(resolveDragOutcome(active, over)).toBeNull();
  });

  it("returns a swap-roles outcome for a valid role drag, with a matching undo entry", () => {
    const source = makeRotaSession({ session_id: 1, day: "Monday", period: "AM" });
    const target = makeRotaSession({ session_id: 2, day: "Monday", period: "AM" });
    const active = { type: "role" as const, session: source };
    const over = { session: target };

    const outcome = resolveDragOutcome(active, over);

    expect(outcome).toEqual({
      chipType: "role",
      sessionAId: 1,
      sessionBId: 2,
      undoEntry: { kind: "swap-roles", sessionAId: 1, sessionBId: 2 },
    });
  });

  it("returns a swap-rooms outcome for a valid room drag, with a matching undo entry", () => {
    const source = makeRotaSession({ session_id: 3, day: "Wednesday", period: "PM" });
    const target = makeRotaSession({ session_id: 4, day: "Wednesday", period: "PM" });
    const active = { type: "room" as const, session: source };
    const over = { session: target };

    const outcome = resolveDragOutcome(active, over);

    expect(outcome).toEqual({
      chipType: "room",
      sessionAId: 3,
      sessionBId: 4,
      undoEntry: { kind: "swap-rooms", sessionAId: 3, sessionBId: 4 },
    });
  });
});