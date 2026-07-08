import { describe, expect, it } from "vitest";

import { mapValidationErrors } from "./mapValidationErrors";

describe("mapValidationErrors", () => {
  it("strips the leading 'body' segment and maps a top-level scalar field", () => {
    const result = mapValidationErrors([{ loc: ["body", "name"], msg: "Field required", type: "missing" }]);
    expect(result.fieldErrors.name).toBe("Field required");
    expect(result.formErrors).toEqual([]);
  });

  it("maps clinic_priority to the camelCase form field name", () => {
    const result = mapValidationErrors([
      { loc: ["body", "clinic_priority"], msg: "Input should be a valid integer", type: "int_type" },
    ]);
    expect(result.fieldErrors.clinicPriority).toBe("Input should be a valid integer");
  });

  it("puts an unrecognised top-level field into formErrors rather than guessing", () => {
    const result = mapValidationErrors([
      { loc: ["body", "some_unknown_field"], msg: "Unexpected", type: "value_error" },
    ]);
    expect(result.fieldErrors).toEqual({});
    expect(result.formErrors).toEqual(["Unexpected"]);
  });

  it("puts a nested path (e.g. a room_eligibilities row error) into formErrors, not a guessed field", () => {
    const result = mapValidationErrors([
      { loc: ["body", "room_eligibilities", 2], msg: "exactly one of room_id / room_type must be set", type: "value_error" },
    ]);
    expect(result.fieldErrors).toEqual({});
    expect(result.formErrors).toEqual(["exactly one of room_id / room_type must be set"]);
  });

  it("handles a loc without a leading 'body' segment (e.g. a query/path param error) without stripping anything real", () => {
    const result = mapValidationErrors([{ loc: ["name"], msg: "Field required", type: "missing" }]);
    expect(result.fieldErrors.name).toBe("Field required");
  });

  it("maps multiple errors independently", () => {
    const result = mapValidationErrors([
      { loc: ["body", "name"], msg: "Field required", type: "missing" },
      { loc: ["body", "clinic_priority"], msg: "Field required", type: "missing" },
    ]);
    expect(result.fieldErrors.name).toBe("Field required");
    expect(result.fieldErrors.clinicPriority).toBe("Field required");
  });
});