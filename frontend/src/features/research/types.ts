/**
 * Wire mirrors for the Research API (`backend/app/research/schemas.py`).
 *
 * These live in the feature folder rather than in `src/api/types.ts`, per
 * "Adding a Module" in `documentation/architecture.md`: a section owns its
 * own wire types. The one exception is the `research` key on `Permissions`,
 * which is shared and stays in `src/api/types.ts`.
 *
 * `StudyStage` is mirrored by **value**, not by index. The backend's
 * `STUDY_STAGE_ORDER` decides what "one stage forward" means; the order
 * repeated here is for display and for naming the next stage in a
 * confirmation, and a mismatch would be a copy error, not a protocol one -
 * the server never takes a stage from the client (Decision 4).
 */

export type StudyStage = "setup" | "recruitment_open" | "recruitment_closed" | "closed";

/** Display order, mirroring `STUDY_STAGE_ORDER` in `models/enums.py`. */
export const STUDY_STAGE_ORDER: readonly StudyStage[] = [
  "setup",
  "recruitment_open",
  "recruitment_closed",
  "closed",
];

export const STAGE_LABELS: Record<StudyStage, string> = {
  setup: "Setup",
  recruitment_open: "Recruitment open",
  recruitment_closed: "Recruitment closed",
  closed: "Closed",
};

export interface StudyContact {
  id: number;
  name: string;
  role: string | null;
  email: string | null;
  phone: string | null;
  display_order: number;
}

/** A contact as the edit dialog sends it - no id, because contacts are
 * saved as a full replace on the study PATCH (Decision 17). */
export interface StudyContactIn {
  name: string;
  role: string | null;
  email: string | null;
  phone: string | null;
}

/**
 * One checklist row that exists. A step with no row is "not done":
 * absence is data here, so the page reads this list against the
 * catalogue rather than expecting eight entries.
 */
export interface StudySetupStep {
  step_key: string;
  done: boolean;
  done_on: string | null;
  note: string | null;
}

export interface SetupStepPatch {
  done?: boolean;
  done_on?: string | null;
  note?: string | null;
}

/** Metadata only - the bytes leave the app through the download endpoint. */
export interface StudyDocument {
  id: number;
  slot: string;
  filename: string;
  content_type: string;
  size_bytes: number;
  uploaded_at: string;
  uploaded_by_user_id: number | null;
}

export interface Study {
  id: number;
  name: string;
  cpms_code: string | null;
  study_type: string | null;
  website_url: string | null;
  owner_user_id: number | null;
  /** Denormalised by the server: the Research preset cannot read /users,
   * so without this the header could only show an id. */
  owner_name: string | null;
  stage: StudyStage;
  setup_entered_on: string | null;
  recruitment_opened_on: string | null;
  recruitment_closed_on: string | null;
  closed_on: string | null;
  created_at: string;
  contacts: StudyContact[];
  setup_steps: StudySetupStep[];
  documents: StudyDocument[];
}

export interface StudyIn {
  name: string;
  cpms_code: string | null;
  study_type: string | null;
  website_url: string | null;
  owner_user_id: number | null;
  contacts: StudyContactIn[];
}

/**
 * PATCH body. Absent means "leave alone", null means "clear" - the server
 * reads `model_fields_set` to tell them apart, so a field the dialog did
 * not touch must be omitted rather than sent as null. `contacts` present
 * is a full replace; absent leaves the contacts alone.
 *
 * `stage` is deliberately not a field: the transition is its own endpoint.
 */
export type StudyPatch = Partial<StudyIn>;
