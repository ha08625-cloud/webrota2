import { describe, expect, it } from "vitest";

import { KEY_DOCUMENT_SLOTS, MAX_DOCUMENT_BYTES, SETUP_STEPS, rejectUploadReason } from "./catalogue";

/**
 * The catalogue is a hand-kept mirror of
 * `backend/app/research/catalogue.py`. These pin the two things a drift
 * would break quietly: the eight step keys the API validates against, and
 * the three key slots the study header renders.
 */
describe("the catalogue", () => {
  it("holds the eight setup steps, in order", () => {
    expect(SETUP_STEPS.map((step) => step.key)).toEqual([
      "mnca",
      "siv_booked",
      "siv_complete",
      "delegation_log",
      "training_log",
      "site_pack",
      "flow_chart",
      "green_light",
    ]);
  });

  // Only these three own a many-file slot named after the step. site_pack
  // has none by design (the intranet is its home) and flow_chart's file is
  // the key slot in the header.
  it("gives a document slot to exactly three steps", () => {
    expect(SETUP_STEPS.filter((step) => step.hasDocuments).map((step) => step.key)).toEqual([
      "mnca",
      "delegation_log",
      "training_log",
    ]);
  });

  it("holds the three key document slots", () => {
    expect(KEY_DOCUMENT_SLOTS.map((slot) => slot.slot)).toEqual([
      "flow_chart",
      "patient_information_leaflet",
      "consent_form",
    ]);
  });
});

describe("rejectUploadReason", () => {
  function file(name: string, size = 10) {
    return new File(["x".repeat(size)], name, { type: "application/octet-stream" });
  }

  it("accepts the allowlisted extensions", () => {
    for (const name of ["a.pdf", "a.DOCX", "a.xlsx", "a.png", "a.jpg", "a.jpeg"]) {
      expect(rejectUploadReason(file(name))).toBeNull();
    }
  });

  it("refuses anything else", () => {
    expect(rejectUploadReason(file("notes.txt"))).toContain("not accepted");
  });

  it("refuses a file over the shared 5 MB cap", () => {
    expect(rejectUploadReason(file("big.pdf", MAX_DOCUMENT_BYTES + 1))).toBe("File exceeds 5 MB");
  });
});
