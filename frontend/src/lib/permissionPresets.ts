import type { AccessLevel, Permissions } from "@/api/types";

/**
 * The permission presets, mirroring app/models/permissions.py. A preset is
 * a starting point, not a role: nothing consults it after a user is saved.
 *
 * Note what "Rota admin" leaves out. Today's `admin` tier can upload and
 * apply signatures; this preset cannot. That narrowing is the point of the
 * feature - a scanned signature should reach as few logins as possible -
 * but it means an existing admin login loses signature access the moment
 * its permissions are set.
 */
export const PERMISSION_PRESETS = {
  manager: {
    clinical: "write",
    reception: "write",
    signatures: true,
    study_eoi: true,
    user_admin: true,
  },
  rota_admin: {
    clinical: "write",
    reception: "write",
    signatures: false,
    study_eoi: false,
    user_admin: false,
  },
  // Reception's rota is built against the clinical one, so a reception
  // administrator reads it by default.
  reception_admin: {
    clinical: "read",
    reception: "write",
    signatures: false,
    study_eoi: false,
    user_admin: false,
  },
  documents: {
    clinical: "none",
    reception: "none",
    signatures: true,
    study_eoi: true,
    user_admin: false,
  },
  read_only: {
    clinical: "read",
    reception: "read",
    signatures: false,
    study_eoi: false,
    user_admin: false,
  },
} as const satisfies Record<string, Permissions>;

export type PermissionPresetName = keyof typeof PERMISSION_PRESETS;

/**
 * The tier a user is given, mapped onto the closest preset - the same
 * mapping the 010 migration backfilled with and seed_users.py derives
 * from. It is what the create form sends until the permission editor
 * lands, so a user created today gets what their tier would have given
 * them before permissions existed.
 */
export const PRESET_FOR_ACCESS_LEVEL: Record<AccessLevel, PermissionPresetName> = {
  manager: "manager",
  admin: "rota_admin",
  doctor: "read_only",
  nurse: "read_only",
};

/** A fresh copy: the preset objects themselves are shared and frozen. */
export function permissionPreset(name: PermissionPresetName): Permissions {
  return { ...PERMISSION_PRESETS[name] };
}

/** True when the set grants nothing at all, which the API refuses (422). */
export function isEmptyPermissions(permissions: Permissions): boolean {
  if (permissions.clinical !== "none" || permissions.reception !== "none") {
    return false;
  }
  return !permissions.signatures && !permissions.study_eoi && !permissions.user_admin;
}
