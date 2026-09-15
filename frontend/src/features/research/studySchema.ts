import { z } from "zod";

import type { Study, StudyIn } from "./types";

/**
 * Form shape and validation for the study header, in its own module so it
 * can be unit-tested without mounting the dialog - the same split as
 * `lib/clinicTypeSchema.ts`.
 *
 * **It mirrors the server's rules and does not add to them.** A client
 * rule the server does not have rejects data the API would accept, which
 * is a bug that only shows up as a user unable to save something legal.
 * So: the name is required, the website must be http/https, and nothing
 * else is constrained - notably contact emails are free text, because
 * `StudyContactIn` does not validate them either. The one rule worth
 * having twice is the URL: the header renders it as a link, and a stored
 * `javascript:` URL rendered as a link is stored XSS. The
 * server is still the one that enforces it.
 */

/** Mirrors `_check_website_url` in `backend/app/research/schemas.py`. */
function isAcceptableUrl(value: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return false;
  }
  return (parsed.protocol === "http:" || parsed.protocol === "https:") && parsed.host !== "";
}

const contactSchema = z.object({
  name: z.string().trim().min(1, "Contact name is required"),
  role: z.string(),
  email: z.string(),
  phone: z.string(),
});

export const studyFormSchema = z.object({
  name: z.string().trim().min(1, "Study name is required"),
  cpmsCode: z.string(),
  studyType: z.string(),
  websiteUrl: z
    .string()
    .refine((value) => value.trim() === "" || isAcceptableUrl(value.trim()), {
      message: "Study website must be a full http:// or https:// address",
    }),
  /** Null is "no owner". The dialog only offers a picker to a login that
   * may read /users; everyone else round-trips the value unchanged. */
  ownerUserId: z.number().int().nullable(),
  contacts: z.array(contactSchema),
});

export type StudyFormValues = z.infer<typeof studyFormSchema>;

export function emptyStudyForm(): StudyFormValues {
  return {
    name: "",
    cpmsCode: "",
    studyType: "",
    websiteUrl: "",
    ownerUserId: null,
    contacts: [],
  };
}

export function emptyContact(): StudyFormValues["contacts"][number] {
  return { name: "", role: "", email: "", phone: "" };
}

export function studyFormValues(study: Study): StudyFormValues {
  return {
    name: study.name,
    cpmsCode: study.cpms_code ?? "",
    studyType: study.study_type ?? "",
    websiteUrl: study.website_url ?? "",
    ownerUserId: study.owner_user_id,
    contacts: study.contacts.map((contact) => ({
      name: contact.name,
      role: contact.role ?? "",
      email: contact.email ?? "",
      phone: contact.phone ?? "",
    })),
  };
}

function orNull(value: string): string | null {
  const cleaned = value.trim();
  return cleaned === "" ? null : cleaned;
}

/**
 * Every field is sent, including the nulls. The API distinguishes absent
 * ("leave alone") from null ("clear"), and this dialog edits the whole
 * header at once, so an emptied box genuinely means cleared. `contacts`
 * is likewise always present, which the server reads as a full replace.
 */
export function toStudyPayload(values: StudyFormValues): StudyIn {
  return {
    name: values.name.trim(),
    cpms_code: orNull(values.cpmsCode),
    study_type: orNull(values.studyType),
    website_url: orNull(values.websiteUrl),
    owner_user_id: values.ownerUserId,
    contacts: values.contacts.map((contact) => ({
      name: contact.name.trim(),
      role: orNull(contact.role),
      email: orNull(contact.email),
      phone: orNull(contact.phone),
    })),
  };
}

/** First issue per top-level field, for display next to each input.
 * Contact rows report under `contacts.<index>.<field>`. */
export function studyFieldErrors(error: z.ZodError): Record<string, string> {
  const fieldErrors: Record<string, string> = {};
  for (const issue of error.issues) {
    const key = issue.path.join(".");
    if (key !== "" && !(key in fieldErrors)) {
      fieldErrors[key] = issue.message;
    }
  }
  return fieldErrors;
}
