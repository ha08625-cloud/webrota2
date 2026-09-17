import { describe, expect, it } from "vitest";

import type { Permissions } from "@/api/types";

import {
  PERMISSION_PRESETS,
  isEmptyPermissions,
  permissionPreset,
  permissionsSummary,
} from "./permissionPresets";

const NOTHING: Permissions = {
  clinical: "none",
  reception: "none",
  research: "none",
  nurse_rota: "none",
  signatures: false,
  study_eoi: false,
  user_admin: false,
};

describe("permissionPreset", () => {
  it("hands out a copy, so one edited set does not rewrite the preset", () => {
    const first = permissionPreset("manager");
    first.user_admin = false;

    expect(permissionPreset("manager").user_admin).toBe(true);
    expect(PERMISSION_PRESETS.manager.user_admin).toBe(true);
  });
});

describe("isEmptyPermissions", () => {
  it("is true only when nothing at all is granted", () => {
    expect(isEmptyPermissions(NOTHING)).toBe(true);
    expect(isEmptyPermissions({ ...NOTHING, clinical: "read" })).toBe(false);
    expect(isEmptyPermissions({ ...NOTHING, study_eoi: true })).toBe(false);
  });

  // The regression this check is derived from the key lists to prevent: a
  // new permission is added, the hand-written check is not updated, and the
  // Users form refuses to save exactly the narrowly scoped login the new
  // permission was added to make possible.
  it("is false for a set holding only the newest permission", () => {
    expect(isEmptyPermissions(permissionPreset("nurse_rota"))).toBe(false);
    expect(isEmptyPermissions({ ...NOTHING, nurse_rota: "read" })).toBe(false);
  });
});

describe("the presets", () => {
  // Decision 10: research is not in any preset but its own and Manager's.
  // Read-only grants both rotas at read, and deliberately not this.
  it("grant research only to Manager and Research", () => {
    const granted = Object.entries(PERMISSION_PRESETS)
      .filter(([, set]) => set.research !== "none")
      .map(([name]) => name);

    expect(granted.sort()).toEqual(["manager", "research"]);
  });

  it("gives the research preset that permission and nothing else", () => {
    expect(permissionsSummary(permissionPreset("research"))).toBe("Research: edit");
  });

  // The point of the nurse_rota area: a nursing login that can edit nurse
  // rows in the master template without holding even read on the clinical
  // rota the same table serves.
  it("gives the nurse rota preset that permission and nothing else", () => {
    expect(permissionsSummary(permissionPreset("nurse_rota"))).toBe("Nurse rota: edit");
  });

  // Rota admin edits it, Read-only reads it, and the two presets that grant
  // no rota at all do not see it.
  it("grant the nurse rota to the rota presets and the read-only one", () => {
    const granted = Object.entries(PERMISSION_PRESETS)
      .filter(([, set]) => set.nurse_rota !== "none")
      .map(([name]) => name);

    expect(granted.sort()).toEqual(["manager", "nurse_rota", "read_only", "rota_admin"]);
  });
});

describe("permissionsSummary", () => {
  it("lists granted areas and flags, and nothing else", () => {
    expect(permissionsSummary(permissionPreset("reception_admin"))).toBe(
      "Clinical rota: read, Reception rota: edit",
    );
    expect(permissionsSummary(permissionPreset("manager"))).toBe(
      "Clinical rota: edit, Reception rota: edit, Nurse rota: edit, Research: edit, " +
        "Signatures, Study EOI, User administration",
    );
  });

  // The deny-everything set is not savable, but it IS what a row inserted
  // outside the app carries (the column's server default), so the table has
  // to render it as something.
  it("says so when nothing is granted", () => {
    expect(permissionsSummary(NOTHING)).toBe("No access");
  });
});
