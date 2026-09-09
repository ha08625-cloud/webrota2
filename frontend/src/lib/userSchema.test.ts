import { describe, expect, it } from "vitest";

import { makeAuthUser } from "@/test/fixtures/reference";
import { EMPTY_PERMISSIONS_MESSAGE, permissionPreset } from "@/lib/permissionPresets";

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
    const result = schema.safeParse({
      email: "a@example.com",
      name: "Ann",
      access_level: "admin",
      permissions: permissionPreset("rota_admin"),
      doctor_id: "",
      reception_staff_id: "",
      password: "short",
    });
    expect(result.success).toBe(false);
  });

  it("rejects a password over 72 characters", () => {
    const result = schema.safeParse({
      email: "a@example.com",
      name: "Ann",
      access_level: "admin",
      permissions: permissionPreset("rota_admin"),
      doctor_id: "",
      reception_staff_id: "",
      password: "x".repeat(73),
    });
    expect(result.success).toBe(false);
  });

  it("rejects an invalid email", () => {
    const result = schema.safeParse({
      email: "not-an-email",
      name: "Ann",
      access_level: "admin",
      permissions: permissionPreset("rota_admin"),
      doctor_id: "",
      reception_staff_id: "",
      password: "password1",
    });
    expect(result.success).toBe(false);
  });

  it("accepts a valid payload", () => {
    const result = schema.safeParse({
      email: "a@example.com",
      name: "Ann",
      access_level: "admin",
      permissions: permissionPreset("rota_admin"),
      doctor_id: "",
      reception_staff_id: "",
      password: "password1",
    });
    expect(result.success).toBe(true);
  });
});

describe("userFormSchema - edit mode", () => {
  const schema = userFormSchema("edit");

  it("accepts an empty password (leave unchanged)", () => {
    const result = schema.safeParse({
      email: "a@example.com",
      name: "Ann",
      access_level: "admin",
      permissions: permissionPreset("rota_admin"),
      doctor_id: "",
      reception_staff_id: "",
      password: "",
    });
    expect(result.success).toBe(true);
  });

  it("still rejects a too-short non-empty password", () => {
    const result = schema.safeParse({
      email: "a@example.com",
      name: "Ann",
      access_level: "admin",
      permissions: permissionPreset("rota_admin"),
      doctor_id: "",
      reception_staff_id: "",
      password: "short",
    });
    expect(result.success).toBe(false);
  });

  it("accepts a valid new password", () => {
    const result = schema.safeParse({
      email: "a@example.com",
      name: "Ann",
      access_level: "admin",
      permissions: permissionPreset("rota_admin"),
      doctor_id: "",
      reception_staff_id: "",
      password: "password1",
    });
    expect(result.success).toBe(true);
  });
});

describe("userFormSchema - permissions", () => {
  const values = {
    email: "a@example.com",
    name: "Ann",
    access_level: "admin" as const,
    doctor_id: "" as const,
    reception_staff_id: "" as const,
    password: "password1",
  };

  // The backend refuses this set with a 422 (PermissionSetIn); refusing it
  // here as well is what turns that into a message next to the controls
  // rather than a banner after a round trip.
  it("rejects a set that grants nothing, with the message the API would send", () => {
    const result = userFormSchema("create").safeParse({
      ...values,
      permissions: {
        clinical: "none",
        reception: "none",
        signatures: false,
        study_eoi: false,
        user_admin: false,
      },
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(mapZodFieldErrors(result.error).permissions).toBe(EMPTY_PERMISSIONS_MESSAGE);
    }
  });

  it.each([
    ["a single flag", { signatures: true }],
    ["read on one area", { clinical: "read" as const }],
  ])("accepts a set granting only %s", (_label, granted) => {
    const result = userFormSchema("create").safeParse({
      ...values,
      permissions: {
        clinical: "none" as const,
        reception: "none" as const,
        signatures: false,
        study_eoi: false,
        user_admin: false,
        ...granted,
      },
    });
    expect(result.success).toBe(true);
  });

  it("formValuesFromUser copies the set rather than sharing the cached user's", () => {
    const user = makeAuthUser({ permissions: permissionPreset("documents") });
    const values = formValuesFromUser(user);

    expect(values.permissions).toEqual(permissionPreset("documents"));
    values.permissions.user_admin = true;
    expect(user.permissions.user_admin).toBe(false);
  });
});

describe("field errors", () => {
  it("maps a validation failure onto its field name", () => {
    const result = userFormSchema("create").safeParse({
      email: "",
      name: "Ann",
      access_level: "admin",
      permissions: permissionPreset("rota_admin"),
      doctor_id: "",
      reception_staff_id: "",
      password: "password1",
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(mapZodFieldErrors(result.error).email).toBeDefined();
    }
  });
});

describe("toCreatePayload / toPatchPayload", () => {
  it("toCreatePayload sends the password as-is", () => {
    const values = {
      email: "a@example.com",
      name: "Ann",
      access_level: "admin" as const,
      permissions: permissionPreset("rota_admin"),
      doctor_id: "" as const,
      reception_staff_id: "" as const,
      password: "password1",
    };
    expect(toCreatePayload(values)).toEqual({
      email: "a@example.com",
      name: "Ann",
      access_level: "admin",
      // Straight through from the form - nothing derives it from the tier.
      permissions: permissionPreset("rota_admin"),
      doctor_id: null,
      reception_staff_id: null,
      password: "password1",
    });
  });

  // `null` rather than an omitted key, in both directions: the backend
  // reads "sent null" as "clear the link" and a missing key as "leave it",
  // so an omitted key would make unlinking impossible from the edit form.
  it("maps the empty 'Not linked' option to an explicit null, and an id straight through", () => {
    const base = {
      email: "a@example.com",
      name: "Ann",
      access_level: "admin" as const,
      permissions: permissionPreset("rota_admin"),
      password: "",
    };
    expect(toPatchPayload({ ...base, doctor_id: "", reception_staff_id: "" })).toMatchObject({
      doctor_id: null,
      reception_staff_id: null,
    });
    expect(toPatchPayload({ ...base, doctor_id: 3, reception_staff_id: 7 })).toMatchObject({
      doctor_id: 3,
      reception_staff_id: 7,
    });
  });

  it("toPatchPayload omits password when left blank", () => {
    const values = {
      email: "a@example.com",
      name: "Ann",
      access_level: "admin" as const,
      permissions: permissionPreset("rota_admin"),
      doctor_id: "" as const,
      reception_staff_id: "" as const,
      password: "",
    };
    expect(toPatchPayload(values)).toEqual({
      email: "a@example.com",
      name: "Ann",
      access_level: "admin",
      permissions: permissionPreset("rota_admin"),
      doctor_id: null,
      reception_staff_id: null,
    });
  });

  it("toPatchPayload always sends access_level, so an edit can change the tier", () => {
    const values = {
      email: "a@example.com",
      name: "Ann",
      access_level: "manager" as const,
      permissions: permissionPreset("rota_admin"),
      doctor_id: "" as const,
      reception_staff_id: "" as const,
      password: "",
    };
    expect(toPatchPayload(values).access_level).toBe("manager");
  });

  it("toPatchPayload includes password when supplied", () => {
    const values = {
      email: "a@example.com",
      name: "Ann",
      access_level: "admin" as const,
      permissions: permissionPreset("rota_admin"),
      doctor_id: "" as const,
      reception_staff_id: "" as const,
      password: "password1",
    };
    expect(toPatchPayload(values)).toEqual({
      email: "a@example.com",
      name: "Ann",
      access_level: "admin",
      permissions: permissionPreset("rota_admin"),
      doctor_id: null,
      reception_staff_id: null,
      password: "password1",
    });
  });
});

describe("formValuesFromUser", () => {
  it("never pre-fills the password field, and carries the user's access level", () => {
    const user = makeAuthUser({ email: "a@example.com", name: "Ann", access_level: "doctor" });
    expect(formValuesFromUser(user)).toEqual({
      email: "a@example.com",
      name: "Ann",
      access_level: "doctor",
      // Whatever the user has, not anything derived from the tier - the
      // fixture user is on the Manager preset.
      permissions: permissionPreset("manager"),
      doctor_id: "",
      reception_staff_id: "",
      password: "",
    });
  });

  it("pre-fills an existing link as its id, and an absent one as the empty option", () => {
    const user = makeAuthUser({
      linked_doctor: { id: 3, code: "AB", active: false },
      linked_reception_staff: null,
    });
    expect(formValuesFromUser(user)).toMatchObject({ doctor_id: 3, reception_staff_id: "" });
  });
});

describe("access_level", () => {
  it("defaults a new user to the least privileged level", () => {
    expect(emptyFormValues().access_level).toBe("nurse");
  });

  it("rejects a level outside the four the backend knows", () => {
    const result = userFormSchema("create").safeParse({
      email: "a@example.com",
      name: "Ann",
      access_level: "superuser",
      permissions: permissionPreset("rota_admin"),
      password: "password1",
    });
    expect(result.success).toBe(false);
  });
});