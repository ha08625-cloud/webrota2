import { describe, expect, it } from "vitest";

import { makeStudy } from "./testFixtures";
import {
  emptyStudyForm,
  studyFieldErrors,
  studyFormSchema,
  studyFormValues,
  toStudyPayload,
} from "./studySchema";

describe("studyFormSchema", () => {
  it("requires a name", () => {
    const result = studyFormSchema.safeParse({ ...emptyStudyForm(), name: "   " });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(studyFieldErrors(result.error).name).toBe("Study name is required");
    }
  });

  it("accepts an http or https website", () => {
    for (const websiteUrl of ["http://example.test/study", "https://example.test"]) {
      const result = studyFormSchema.safeParse({ ...emptyStudyForm(), name: "S", websiteUrl });
      expect(result.success).toBe(true);
    }
  });

  // The rule that keeps a javascript: URL out of an href the header
  // renders - the server enforces the same one (Decision 17).
  it("rejects a website that is not http or https", () => {
    for (const websiteUrl of ["javascript:alert(1)", "example.test", "ftp://example.test"]) {
      const result = studyFormSchema.safeParse({ ...emptyStudyForm(), name: "S", websiteUrl });
      expect(result.success).toBe(false);
    }
  });

  it("treats an empty website box as no website", () => {
    const result = studyFormSchema.safeParse({ ...emptyStudyForm(), name: "S", websiteUrl: "" });

    expect(result.success).toBe(true);
  });

  it("requires a name on every contact row", () => {
    const result = studyFormSchema.safeParse({
      ...emptyStudyForm(),
      name: "S",
      contacts: [{ name: "", role: "", email: "", phone: "" }],
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(studyFieldErrors(result.error)["contacts.0.name"]).toBe("Contact name is required");
    }
  });
});

describe("toStudyPayload", () => {
  it("sends blanked optional fields as null rather than empty strings", () => {
    const payload = toStudyPayload({
      ...emptyStudyForm(),
      name: "  ACME-1  ",
      cpmsCode: "  ",
      studyType: "",
      websiteUrl: "",
    });

    expect(payload).toEqual({
      name: "ACME-1",
      cpms_code: null,
      study_type: null,
      website_url: null,
      owner_user_id: null,
      contacts: [],
    });
  });

  it("carries the whole contacts list, since the server reads it as a replace", () => {
    const payload = toStudyPayload({
      ...emptyStudyForm(),
      name: "ACME-1",
      contacts: [{ name: "Jo", role: "CRA", email: "", phone: "01234" }],
    });

    expect(payload.contacts).toEqual([
      { name: "Jo", role: "CRA", email: null, phone: "01234" },
    ]);
  });
});

describe("studyFormValues", () => {
  it("round-trips a study's nulls as empty boxes", () => {
    const values = studyFormValues(
      makeStudy({
        cpms_code: null,
        study_type: null,
        website_url: null,
        contacts: [
          { id: 3, name: "Jo", role: null, email: "jo@example.test", phone: null, display_order: 0 },
        ],
      }),
    );

    expect(values.cpmsCode).toBe("");
    expect(values.studyType).toBe("");
    expect(values.websiteUrl).toBe("");
    expect(values.contacts).toEqual([
      { name: "Jo", role: "", email: "jo@example.test", phone: "" },
    ]);
  });
});
