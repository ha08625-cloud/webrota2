import { z } from "zod";

import type { AccessLevel, AuthUser, UserIn, UserPatch } from "@/api/types";
import { ACCESS_LEVELS } from "./accessLevels";
import { EMPTY_PERMISSIONS_MESSAGE, isEmptyPermissions, permissionPreset } from "./permissionPresets";

/**
 * Mirrors the backend exactly (schemas/auth.py UserIn/UserPatch): min 8,
 * max 72 - the 72 ceiling is bcrypt's own silent-truncation limit, made
 * visible here rather than left to fail invisibly server-side.
 *
 * Password is required on create. On edit, an empty string means "leave
 * the current password unchanged" (auth plan, Task 6 - this is the whole
 * password-reset mechanism, there is no separate flow), so the edit
 * schema accepts "" as well as a valid 8-72 char password, but nothing
 * in between - a 5-character edit attempt is still rejected.
 */
const PASSWORD_MIN = 8;
const PASSWORD_MAX = 72;

const emailField = z.string().min(1, "Email is required").email("Enter a valid email address");
const nameField = z.string().min(1, "Name is required");
/**
 * Mirrors AccessLevel on the backend, which requires it on UserIn rather
 * than defaulting - so the form always sends one, and a value outside the
 * four is a client-side failure rather than a 422.
 */
const accessLevelField = z.enum(ACCESS_LEVELS as readonly [AccessLevel, ...AccessLevel[]]);
/**
 * The two optional staff links. `""` is the "Not linked" option - the
 * same way LeavePage models an empty doctor select - and maps to an
 * explicit `null` on the wire, never to an omitted key: the backend
 * distinguishes "sent null" (clear the link) from "not sent" (leave it),
 * and the edit form has to be able to clear.
 *
 * Nothing here touches access_level. The link is identity, the level is
 * permission, and neither derives the other.
 */
const staffLinkField = z.union([z.number(), z.literal("")]);
/**
 * Mirrors PermissionSetIn (schemas/auth.py): all five keys required, so
 * the form can never send a partial set and have the backend fill the
 * gaps with "denied" behind the user's back. The non-empty rule that
 * schema enforces is applied below, on the whole form object, because a
 * Zod refinement on a nested object reports its path there and
 * mapZodFieldErrors only reads the first path segment.
 */
const permissionsField = z.object({
  clinical: z.enum(["none", "read", "write"]),
  reception: z.enum(["none", "read", "write"]),
  signatures: z.boolean(),
  study_eoi: z.boolean(),
  user_admin: z.boolean(),
});
/** Exported for ChangePasswordDialog, which validates a bare password with no surrounding form. */
export const passwordRule = z
  .string()
  .min(PASSWORD_MIN, `Must be at least ${PASSWORD_MIN} characters`)
  .max(PASSWORD_MAX, `Must be ${PASSWORD_MAX} characters or fewer`);

export function userFormSchema(mode: "create" | "edit") {
  return z
    .object({
      email: emailField,
      name: nameField,
      access_level: accessLevelField,
      permissions: permissionsField,
      doctor_id: staffLinkField,
      reception_staff_id: staffLinkField,
      password: mode === "create" ? passwordRule : z.union([z.literal(""), passwordRule]),
    })
    // Plan D15, mirroring the backend's model_validator with the same
    // message: a login that can reach nothing is never what anyone meant,
    // and "no access" is spelled by deactivating the user.
    .superRefine((values, ctx) => {
      if (isEmptyPermissions(values.permissions)) {
        ctx.addIssue({
          code: "custom",
          path: ["permissions"],
          message: EMPTY_PERMISSIONS_MESSAGE,
        });
      }
    });
}

export type UserFormValues = z.infer<ReturnType<typeof userFormSchema>>;

/** New users start as "nurse" on the Read-only preset, for the same reason the migration defaults low: an accidental viewer is recoverable, an accidental manager is a silent hole. */
export function emptyFormValues(): UserFormValues {
  return {
    email: "",
    name: "",
    access_level: "nurse",
    permissions: permissionPreset("read_only"),
    doctor_id: "",
    reception_staff_id: "",
    password: "",
  };
}

/** Password is never pre-filled - UserOut carries no password_hash to show, and a blank field is exactly what "leave blank to keep current" needs. */
export function formValuesFromUser(user: AuthUser): UserFormValues {
  return {
    email: user.email,
    name: user.name,
    access_level: user.access_level,
    // Copied, not shared: the editor mutates this object as controls are
    // touched, and the cached user from the list must not move with it.
    permissions: { ...user.permissions },
    doctor_id: user.linked_doctor?.id ?? "",
    reception_staff_id: user.linked_reception_staff?.id ?? "",
    password: "",
  };
}

/** `""` (the "Not linked" option) becomes an explicit null - see staffLinkField. */
function staffLinkPayload(value: number | ""): number | null {
  return value === "" ? null : value;
}

/**
 * `permissions` comes straight from the editor in both payloads. It is
 * required on create, and the PATCH sends the whole set because the
 * backend replaces rather than merges - the form always holds the user's
 * current set (formValuesFromUser), so an edit that never touches the
 * permission controls re-sends exactly what was there.
 *
 * Nothing derives permissions from `access_level` any more: the tier is a
 * label, and the presets are a button in the form, not a mapping.
 */
export function toCreatePayload(values: UserFormValues): UserIn {
  return {
    email: values.email,
    name: values.name,
    access_level: values.access_level,
    permissions: values.permissions,
    doctor_id: staffLinkPayload(values.doctor_id),
    reception_staff_id: staffLinkPayload(values.reception_staff_id),
    password: values.password,
  };
}

/** Omits `password` entirely when left blank, so the server's exclude_unset PATCH leaves the stored hash - and every existing session - untouched. */
export function toPatchPayload(values: UserFormValues): UserPatch {
  const patch: UserPatch = {
    email: values.email,
    name: values.name,
    access_level: values.access_level,
    permissions: values.permissions,
    doctor_id: staffLinkPayload(values.doctor_id),
    reception_staff_id: staffLinkPayload(values.reception_staff_id),
  };
  if (values.password !== "") {
    patch.password = values.password;
  }
  return patch;
}

/** Maps Zod's client-side validation issues onto top-level form field keys. */
export function mapZodFieldErrors(error: z.ZodError): Record<string, string> {
  const fieldErrors: Record<string, string> = {};
  for (const issue of error.issues) {
    const key = issue.path[0];
    if (typeof key === "string" && !(key in fieldErrors)) {
      fieldErrors[key] = issue.message;
    }
  }
  return fieldErrors;
}