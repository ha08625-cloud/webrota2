import type { AccessArea, Permissions } from "@/api/types";

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
    research: "write",
    nurse_rota: "write",
    signatures: true,
    study_eoi: true,
    user_admin: true,
  },
  rota_admin: {
    clinical: "write",
    reception: "write",
    research: "none",
    nurse_rota: "write",
    signatures: false,
    study_eoi: false,
    user_admin: false,
  },
  // Reception's rota is built against the clinical one, so a reception
  // administrator reads it by default.
  reception_admin: {
    clinical: "read",
    reception: "write",
    research: "none",
    nurse_rota: "none",
    signatures: false,
    study_eoi: false,
    user_admin: false,
  },
  documents: {
    clinical: "none",
    reception: "none",
    research: "none",
    nurse_rota: "none",
    signatures: true,
    study_eoi: true,
    user_admin: false,
  },
  // The three rotas at read, and research at none: a rota is something
  // everybody benefits from seeing, and a study page is not.
  read_only: {
    clinical: "read",
    reception: "read",
    research: "none",
    nurse_rota: "read",
    signatures: false,
    study_eoi: false,
    user_admin: false,
  },
  // Exactly the research section and nothing else: the person who runs
  // studies has no business with a scanned signature, and the point of the
  // permission model is that they do not have to be given one.
  research: {
    clinical: "none",
    reception: "none",
    research: "write",
    nurse_rota: "none",
    signatures: false,
    study_eoi: false,
    user_admin: false,
  },
  // The nursing team's login: the nurse rota and nothing else, not even
  // read on the clinical rota. It is the tightest preset in the table, and
  // it is the one the nurse_rota area exists for - a login that can edit
  // nurse rows in the master template without being able to reach a
  // doctor's row at all.
  nurse_rota: {
    clinical: "none",
    reception: "none",
    research: "none",
    nurse_rota: "write",
    signatures: false,
    study_eoi: false,
    user_admin: false,
  },
} as const satisfies Record<string, Permissions>;

export type PermissionPresetName = keyof typeof PERMISSION_PRESETS;

/** A fresh copy - PERMISSION_PRESETS' objects are shared module state, and
 * the editor mutates what this returns. */
export function permissionPreset(name: PermissionPresetName): Permissions {
  return { ...PERMISSION_PRESETS[name] };
}

/**
 * True when the set grants nothing at all, which the API refuses (422).
 *
 * Derived from the two key lists rather than naming each key by hand. The
 * hand-written version was a trap: a new permission is added to the type
 * and the presets, the check is not updated, and a login holding only the
 * new permission reads as empty - so the form refuses to save exactly the
 * narrowly scoped user the permission was added for.
 */
export function isEmptyPermissions(permissions: Permissions): boolean {
  if (PERMISSION_AREAS.some((area) => permissions[area] !== "none")) {
    return false;
  }
  return PERMISSION_FLAGS.every((flag) => !permissions[flag]);
}

/** Display order for the preset buttons, most privileged first. */
export const PRESET_ORDER: readonly PermissionPresetName[] = [
  "manager",
  "rota_admin",
  "reception_admin",
  "documents",
  "research",
  "nurse_rota",
  "read_only",
];

const PRESET_LABELS: Record<PermissionPresetName, string> = {
  manager: "Manager",
  rota_admin: "Rota admin",
  reception_admin: "Reception admin",
  documents: "Documents",
  research: "Research",
  nurse_rota: "Nurse rota",
  read_only: "Read-only",
};

export function presetLabel(name: PermissionPresetName): string {
  return PRESET_LABELS[name];
}

/** The four levelled areas, in the order the editor renders them. */
export const PERMISSION_AREAS = ["clinical", "reception", "nurse_rota", "research"] as const;
/** The three flags, in the order the editor renders them. */
export const PERMISSION_FLAGS = ["signatures", "study_eoi", "user_admin"] as const;

export type PermissionAreaKey = (typeof PERMISSION_AREAS)[number];
export type PermissionFlagKey = (typeof PERMISSION_FLAGS)[number];

const AREA_LABELS: Record<PermissionAreaKey, string> = {
  clinical: "Clinical rota",
  reception: "Reception rota",
  nurse_rota: "Nurse rota",
  research: "Research",
};

const FLAG_LABELS: Record<PermissionFlagKey, string> = {
  signatures: "Signatures",
  study_eoi: "Study EOI",
  user_admin: "User administration",
};

/**
 * What each flag actually grants, for the checkbox hints. Signatures says
 * "view" out loud because that is the non-obvious half: the permission
 * gates reading a scanned signature image, not just applying one.
 */
const FLAG_DESCRIPTIONS: Record<PermissionFlagKey, string> = {
  signatures: "View, upload and apply scanned signatures",
  study_eoi: "Fill study expression-of-interest forms",
  user_admin: "Manage logins and read the audit log",
};

const LEVEL_LABELS: Record<AccessArea, string> = {
  none: "None",
  read: "Read only",
  write: "Can edit",
};

export function permissionAreaLabel(area: PermissionAreaKey): string {
  return AREA_LABELS[area];
}

export function permissionFlagLabel(flag: PermissionFlagKey): string {
  return FLAG_LABELS[flag];
}

export function permissionFlagDescription(flag: PermissionFlagKey): string {
  return FLAG_DESCRIPTIONS[flag];
}

export function accessAreaLabel(level: AccessArea): string {
  return LEVEL_LABELS[level];
}

/**
 * A one-line summary for the users table - "Clinical: edit, Reception:
 * read, Signatures". Denied areas and unset flags are left out rather than
 * listed as "none": the row is scanned for what someone *can* do, and
 * seven entries per row of which five say "no" is unreadable.
 */
export function permissionsSummary(permissions: Permissions): string {
  const parts: string[] = [];
  for (const area of PERMISSION_AREAS) {
    const level = permissions[area];
    if (level !== "none") {
      parts.push(`${AREA_LABELS[area]}: ${level === "write" ? "edit" : "read"}`);
    }
  }
  for (const flag of PERMISSION_FLAGS) {
    if (permissions[flag]) {
      parts.push(FLAG_LABELS[flag]);
    }
  }
  return parts.length > 0 ? parts.join(", ") : "No access";
}

/**
 * The message the API returns for an empty set (EMPTY_PERMISSIONS_MESSAGE
 * in models/permissions.py), repeated verbatim so the form can say the
 * same thing before it submits rather than after a 422.
 */
export const EMPTY_PERMISSIONS_MESSAGE =
  "A user needs at least one permission. To remove someone's access " +
  "entirely, deactivate the user instead.";
