import { describe, expect, it } from "vitest";

import { makeAuthUser } from "@/test/fixtures/reference";

import {
  emptyFormValues,
  formValuesFromUser,
  mapZodFieldErrors,
  toCreatePayload,
  toPatchPayload,
  userFormSchema,
} from "./userSchema";

describe("userFormSchema - create mode", () => {
  const schema = userFormSchema("create");

  it("rejects an empty form", () => {
    const result = schema.safeParse(emptyFormValues());
    expect(result.success).toBe(false);
  });

  it("rejects a password under 8 characters", () => {
    const result = schema.safeParse({ email: "a@example.com", name: "Ann", password: "short" });
    expect(result.success).toBe(false);
  });

  it("rejects a password over 72 characters", () => {
    const result = schema.safeParse({ email: "a@example.com", name: "Ann", password: "x".repeat(73) });
    expect(result.success).toBe(false);
  });

  it("rejects an invalid email", () => {
    const result = schema.safeParse({ email: "not-an-email", name: "Ann", password: "password1" });
    expect(result.success).toBe(false);
  });

  it("accepts a valid payload", () => {
    const result = schema.safeParse({ email: "a@example.com", name: "Ann", password: "password1" });
    expect(result.success).toBe(true);
  });
});

describe("userFormSchema - edit mode", () => {
  const schema = userFormSchema("edit");

  it("accepts an empty password (leave unchanged)", () => {
    const result = schema.safeParse({ email: "a@example.com", name: "Ann", password: "" });
    expect(result.success).toBe(true);
  });

  it("still rejects a too-short non-empty password", () => {
    const result = schema.safeParse({ email: "a@example.com", name: "Ann", password: "short" });
    expect(result.success).toBe(false);
  });

  it("accepts a valid new password", () => {
    const result = schema.safeParse({ email: "a@example.com", name: "Ann", password: "password1" });
    expect(result.success).toBe(true);
  });
});

describe("field errors", () => {
  it("maps a validation failure onto its field name", () => {
    const result = userFormSchema("create").safeParse({ email: "", name: "Ann", password: "password1" });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(mapZodFieldErrors(result.error).email).toBeDefined();
    }
  });
});

describe("toCreatePayload / toPatchPayload", () => {
  it("toCreatePayload sends the password as-is", () => {
    const values = { email: "a@example.com", name: "Ann", password: "password1" };
    expect(toCreatePayload(values)).toEqual(values);
  });

  it("toPatchPayload omits password when left blank", () => {
    const values = { email: "a@example.com", name: "Ann", password: "" };
    expect(toPatchPayload(values)).toEqual({ email: "a@example.com", name: "Ann" });
  });

  it("toPatchPayload includes password when supplied", () => {
    const values = { email: "a@example.com", name: "Ann", password: "password1" };
    expect(toPatchPayload(values)).toEqual({
      email: "a@example.com",
      name: "Ann",
      password: "password1",
    });
  });
});

describe("formValuesFromUser", () => {
  it("never pre-fills the password field", () => {
    const user = makeAuthUser({ email: "a@example.com", name: "Ann" });
    expect(formValuesFromUser(user)).toEqual({ email: "a@example.com", name: "Ann", password: "" });
  });
});