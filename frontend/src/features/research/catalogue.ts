/**
 * The frontend mirror of `backend/app/research/catalogue.py`: the eight
 * setup steps and the three key document slots, with their labels and
 * their order in one place rather than inlined in a component.
 *
 * It is a mirror, not a fetch. The catalogue is static, it is small, and
 * an endpoint to serve it would be a request on every page load to learn
 * eight strings that change once a year. The cost is that adding a step
 * is an edit in two files; the constraint that makes that safe is that
 * `step_key` is validated server-side, so a key that drifts out of sync
 * fails loudly with a 422 rather than silently writing a row nothing
 * renders.
 *
 * `flow_chart` appears in both tables and means a different thing in
 * each: a step key that owns no document slot, and a key document slot
 * that is not a step's. The file belongs in the header so it stays
 * visible in every stage; the step survives as a tick only (Decision 8).
 */

export interface SetupStep {
  key: string;
  label: string;
  /** Whether this step owns a many-file document slot named after its key -
   * not "this step involves a document". See the module docstring. */
  hasDocuments: boolean;
  /** Shown beside the step, where the intranet is the home for the file. */
  hint?: string;
}

export const SETUP_STEPS: readonly SetupStep[] = [
  { key: "mnca", label: "Sign mNCA", hasDocuments: true },
  { key: "siv_booked", label: "Book Site Initiation Visit", hasDocuments: false },
  { key: "siv_complete", label: "Complete Site Initiation Visit", hasDocuments: false },
  { key: "delegation_log", label: "Complete delegation log", hasDocuments: true },
  { key: "training_log", label: "Complete training log", hasDocuments: true },
  {
    key: "site_pack",
    label: "Site pack received",
    hasDocuments: false,
    hint: "The site pack stays on the intranet - do not copy it here.",
  },
  {
    key: "flow_chart",
    label: "Flow chart completed",
    hasDocuments: false,
    hint: "The file itself goes in the Flow chart slot above.",
  },
  { key: "green_light", label: "Green light to start recruitment", hasDocuments: false },
];

export interface KeyDocumentSlot {
  slot: string;
  label: string;
}

/** The three documents the team actually opens, shown in the study header
 * in every stage. All three are blank study templates (Decision 9). */
export const KEY_DOCUMENT_SLOTS: readonly KeyDocumentSlot[] = [
  { slot: "flow_chart", label: "Flow chart" },
  { slot: "patient_information_leaflet", label: "Patient information leaflet" },
  { slot: "consent_form", label: "Consent form" },
];

/** Upload limits, mirroring the server's. The pre-check exists to give a
 * faster message; the server stays authoritative. */
export const MAX_DOCUMENT_BYTES = 5 * 1024 * 1024;

export const ACCEPTED_UPLOAD_TYPES =
  ".pdf,.docx,.xlsx,.png,.jpg,.jpeg";

export const ACCEPTED_UPLOAD_TEXT = "PDF, Word (.docx), Excel (.xlsx), PNG or JPEG";

const ACCEPTED_EXTENSIONS = [".pdf", ".docx", ".xlsx", ".png", ".jpg", ".jpeg"];

/**
 * The client-side pre-check: extension only, deliberately. The server
 * checks the declared content type *and* the extension, and a browser's
 * `File.type` is empty often enough (an unregistered MIME type on the
 * uploading machine) that refusing on it here would block files the
 * server would accept.
 */
export function rejectUploadReason(file: File): string | null {
  const lower = file.name.toLowerCase();
  if (!ACCEPTED_EXTENSIONS.some((extension) => lower.endsWith(extension))) {
    return `This file type is not accepted. Upload a ${ACCEPTED_UPLOAD_TEXT} file.`;
  }
  if (file.size > MAX_DOCUMENT_BYTES) {
    return "File exceeds 5 MB";
  }
  return null;
}
