import { describe, expect, it } from "vitest";

import { makeReceptionMasterSession } from "@/test/fixtures/reception";

import { receptionRunContinuations } from "./receptionRuns";

describe("receptionRunContinuations", () => {
  it("returns all false for an all-absent row", () => {
    expect(receptionRunContinuations([undefined, undefined, undefined])).toEqual([false, false, false]);
  });

  it("never flags the first slot, even when the second slot matches it", () => {
    const a = makeReceptionMasterSession({ hour: 8, role: "phones", note: null });
    const b = makeReceptionMasterSession({ hour: 8.5, role: "phones", note: null });
    expect(receptionRunContinuations([a, b])).toEqual([false, true]);
  });

  it("flags a second slot with the same role and same note as a continuation", () => {
    const a = makeReceptionMasterSession({ hour: 8, role: "phones", note: "cover" });
    const b = makeReceptionMasterSession({ hour: 8.5, role: "phones", note: "cover" });
    expect(receptionRunContinuations([a, b])).toEqual([false, true]);
  });

  it("does not merge when the role matches but the note differs", () => {
    const a = makeReceptionMasterSession({ hour: 8, role: "phones", note: "cover" });
    const b = makeReceptionMasterSession({ hour: 8.5, role: "phones", note: "other" });
    expect(receptionRunContinuations([a, b])).toEqual([false, false]);
  });

  it("does not merge when the note matches but the role differs", () => {
    const a = makeReceptionMasterSession({ hour: 8, role: "phones", note: "cover" });
    const b = makeReceptionMasterSession({ hour: 8.5, role: "other", note: "cover" });
    expect(receptionRunContinuations([a, b])).toEqual([false, false]);
  });

  it("treats note: null and note: '' as matching", () => {
    const a = makeReceptionMasterSession({ hour: 8, role: "phones", note: null });
    const b = makeReceptionMasterSession({ hour: 8.5, role: "phones", note: "" });
    expect(receptionRunContinuations([a, b])).toEqual([false, true]);
  });

  it("breaks a run at an absent slot: neither the absent slot nor the one after it continues", () => {
    const a = makeReceptionMasterSession({ hour: 8, role: "phones", note: null });
    const c = makeReceptionMasterSession({ hour: 9, role: "phones", note: null });
    expect(receptionRunContinuations([a, undefined, c])).toEqual([false, false, false]);
  });

  it("flags every slot after the first in a five-slot uniform run", () => {
    const slots = [8, 8.5, 9, 9.5, 10].map((hour) =>
      makeReceptionMasterSession({ hour, role: "phones", note: null }),
    );
    expect(receptionRunContinuations(slots)).toEqual([false, true, true, true, true]);
  });
});
