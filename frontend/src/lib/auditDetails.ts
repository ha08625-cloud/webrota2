/**
 * Turning an audit row's request body into something readable.
 *
 * The backend supplies the sentence and the outcome (see
 * `app/api/audit_descriptions.py`); what it cannot supply is names for the
 * ids inside the body, because those come from tables the audit row does
 * not join to. So `{"doctor_id":34,"room_id":7}` is humanised here, at
 * render time, against lists the page has already fetched.
 *
 * Two deliberate limits:
 *
 * - Only ids that have a lookup are resolved. Everything else renders as
 *   "Room: 7" rather than guessing, which is honest and still a long way
 *   ahead of raw JSON.
 * - A name is resolved from the CURRENT list, not from how things stood
 *   when the request was made. A doctor renamed since then reads under
 *   their new code, and one deleted since then falls back to "#34". The
 *   row itself only ever stored the id, so there is nothing better
 *   available; the alternative is showing the id to everybody.
 */

/** Current-name lookups, keyed by id. Any may be absent. */
export interface AuditLookups {
  /** Doctor id -> code ("AB"), the label the rota grids use. */
  doctorCodes?: Map<number, string>;
  /** User id -> display name. */
  userNames?: Map<number, string>;
}

export interface AuditField {
  label: string;
  value: string;
}

/**
 * Keys whose plain-English label is not just the de-underscored key.
 * Kept small on purpose: the general rule below handles the long tail,
 * and every entry here is one more thing to keep in step with the API.
 */
const KEY_LABELS: Record<string, string> = {
  doctor_id: "Doctor",
  user_id: "User",
  room_id: "Room",
  session_id: "Session",
  rota_id: "Rota",
  staff_id: "Staff member",
  clinic_type_id: "Clinic type",
  leave_id: "Leave entry",
  a_session_id: "First session",
  b_session_id: "Second session",
  access_level: "Access level",
  is_am: "Morning",
  _audit: "Note",
};

/**
 * "sessions_per_week" -> "Sessions per week"; "doctor_id" -> "Doctor".
 * The trailing "_id" is dropped because the value beside it is either a
 * resolved name (where "Doctor: AB" is right and "Doctor id: AB" is not)
 * or "#34", which already reads as an id.
 */
export function humaniseKey(key: string): string {
  const mapped = KEY_LABELS[key];
  if (mapped) {
    return mapped;
  }
  const words = key.replace(/_id$/, "").split("_").filter(Boolean);
  if (words.length === 0) {
    return key;
  }
  return words[0].charAt(0).toUpperCase() + words[0].slice(1) + (words.length > 1 ? ` ${words.slice(1).join(" ")}` : "");
}

function lookupFor(key: string, lookups: AuditLookups): Map<number, string> | undefined {
  if (key === "doctor_id") {
    return lookups.doctorCodes;
  }
  if (key === "user_id") {
    return lookups.userNames;
  }
  return undefined;
}

/** One body value as display text. Never throws - a bad row must not blank the page. */
export function humaniseValue(key: string, value: unknown, lookups: AuditLookups = {}): string {
  if (value === null || value === undefined) {
    return "(none)";
  }
  if (typeof value === "boolean") {
    return value ? "Yes" : "No";
  }
  if (typeof value === "number" || typeof value === "string") {
    const map = lookupFor(key, lookups);
    if (map) {
      // Path params arrive as strings and bodies as numbers, so both are
      // normalised before the lookup rather than only one working.
      const id = typeof value === "number" ? value : Number.parseInt(value, 10);
      if (!Number.isNaN(id)) {
        return map.get(id) ?? `#${id}`;
      }
    }
    return String(value);
  }
  if (Array.isArray(value)) {
    // Primitive lists ("Mon, Tue") read far better than their JSON; a
    // list of objects has no such rendering, so it keeps its JSON.
    if (value.every((v) => typeof v === "string" || typeof v === "number")) {
      return value.length === 0 ? "(empty)" : value.join(", ");
    }
    return JSON.stringify(value);
  }
  return JSON.stringify(value);
}

/**
 * The request body as label/value pairs, in the order the API sent them.
 *
 * The `{"_audit": ...}` markers the backend writes for a body it could not
 * store (too large, unparseable, not JSON) pass through the same path:
 * the marker's own text becomes the value, which is already a sentence.
 */
export function describeAuditBody(
  body: Record<string, unknown> | null,
  lookups: AuditLookups = {},
): AuditField[] {
  if (!body) {
    return [];
  }
  return Object.entries(body).map(([key, value]) => ({
    label: humaniseKey(key),
    value: humaniseValue(key, value, lookups),
  }));
}

/**
 * A single-line version of the same, for the table cell. The full set is
 * behind the row's expander, so this only has to be enough to tell two
 * rows apart at a glance.
 */
export function summariseAuditBody(
  body: Record<string, unknown> | null,
  lookups: AuditLookups = {},
  maxLength = 70,
): string {
  const text = describeAuditBody(body, lookups)
    .map((f) => `${f.label}: ${f.value}`)
    .join(", ");
  return text.length > maxLength ? `${text.slice(0, maxLength)}...` : text;
}

/** Tailwind classes for an outcome, so a problem row is visible while scanning. */
export function outcomeClass(outcome: string): string {
  return outcome === "Done" ? "text-ink/70" : "text-red-700";
}
