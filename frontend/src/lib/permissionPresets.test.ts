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
});

describe("permissionsSummary", () => {
  it("lists granted areas and flags, and nothing else", () => {
    expect(permissionsSummary(permissionPreset("reception_admin"))).toBe(
      "Clinical rota: read, Reception rota: edit",
    );
    expect(permissionsSummary(permissionPreset("manager"))).toBe(
      "Clinical rota: edit, Reception rota: edit, Signatures, Study EOI, User administration",
    );
  });

  // The deny-everything set is not savable, but it IS what a row inserted
  // outside the app carries (the column's server default), so the table has
  // to render it as something.
  it("says so when nothing is granted", () => {
    expect(permissionsSummary(NOTHING)).toBe("No access");
  });
});
