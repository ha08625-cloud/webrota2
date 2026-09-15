import type { Study, StudyDocument, StudySetupStep } from "./types";

/**
 * Study fixtures for this section's tests. They live beside the feature
 * rather than in `src/test/fixtures/`, following the same
 * section-owns-its-own-files convention as the rest of the folder; only
 * test files import them.
 */
export function makeStudy(overrides: Partial<Study> = {}): Study {
  return {
    id: 1,
    name: "ACME-1",
    cpms_code: "12345",
    study_type: "Interventional",
    website_url: null,
    owner_user_id: null,
    owner_name: null,
    stage: "setup",
    setup_entered_on: "2026-01-05",
    recruitment_opened_on: null,
    recruitment_closed_on: null,
    closed_on: null,
    created_at: "2026-01-05T09:00:00Z",
    contacts: [],
    setup_steps: [],
    documents: [],
    ...overrides,
  };
}

export function makeSetupStep(overrides: Partial<StudySetupStep> = {}): StudySetupStep {
  return { step_key: "mnca", done: true, done_on: "2026-01-06", note: null, ...overrides };
}

export function makeDocument(overrides: Partial<StudyDocument> = {}): StudyDocument {
  return {
    id: 10,
    slot: "consent_form",
    filename: "consent-v2.pdf",
    content_type: "application/pdf",
    size_bytes: 2048,
    uploaded_at: "2026-01-07T09:00:00Z",
    uploaded_by_user_id: 1,
    ...overrides,
  };
}
