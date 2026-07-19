import { z } from "zod";

import type { AuthUser, UserIn, UserPatch } from "@/api/types";

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
const passwordRule = z
  .string()
  .min(PASSWORD_MIN, `Must be at least ${PASSWORD_MIN} characters`)
  .max(PASSWORD_MAX, `Must be ${PASSWORD_MAX} characters or fewer`);

export function userFormSchema(mode: "create" | "edit") {
  return z.object({
    email: emailField,
    name: nameField,
    password: mode === "create" ? passwordRule : z.union([z.literal(""), passwordRule]),
  });
}

export type UserFormValues = z.infer<ReturnType<typeof userFormSchema>>;

export function emptyFormValues(): UserFormValues {
  return { email: "", name: "", password: "" };
}

/** Password is never pre-filled - UserOut carries no password_hash to show, and a blank field is exactly what "leave blank to keep current" needs. */
export function formValuesFromUser(user: AuthUser): UserFormValues {
  return { email: user.email, name: user.name, password: "" };
}

export function toCreatePayload(values: UserFormValues): UserIn {
  return { email: values.email, name: values.name, password: values.password };
}

/** Omits `password` entirely when left blank, so the server's exclude_unset PATCH leaves the stored hash - and every existing session - untouched. */
export function toPatchPayload(values: UserFormValues): UserPatch {
  const patch: UserPatch = { email: values.email, name: values.name };
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