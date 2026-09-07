import { HttpResponse, http } from "msw";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";

import { PERMISSION_PRESETS, makeAuthUser, makeDoctor } from "@/test/fixtures/reference";
import { makeReceptionStaff } from "@/test/fixtures/reception";
import { renderWithProviders } from "@/test/renderWithProviders";
import { server } from "@/test/msw/server";
import { permissionPreset } from "@/lib/permissionPresets";

import { UserFormDialog } from "./UserFormDialog";

/** The dialog reads all three lists to build its two link selects. */
function setUpStaff({
  doctors = [],
  receptionStaff = [],
  users = [],
}: {
  doctors?: ReturnType<typeof makeDoctor>[];
  receptionStaff?: ReturnType<typeof makeReceptionStaff>[];
  users?: ReturnType<typeof makeAuthUser>[];
} = {}) {
  server.use(
    http.get("/api/v1/doctors", () => HttpResponse.json(doctors)),
    http.get("/api/v1/reception/staff", () => HttpResponse.json(receptionStaff)),
    http.get("/api/v1/users", () => HttpResponse.json(users)),
  );
}

describe("UserFormDialog - create mode", () => {
  it("renders an empty form labelled 'Password'", async () => {
    renderWithProviders(<UserFormDialog open onOpenChange={() => {}} />);

    expect(await screen.findByRole("heading", { name: "New User" })).toBeInTheDocument();
    expect(screen.getByLabelText("Email")).toHaveValue("");
    expect(screen.getByLabelText("Password")).toBeInTheDocument();
    expect(screen.queryByText(/Leave blank/)).not.toBeInTheDocument();
  });

  it("submits a create payload via POST /users", async () => {
    let capturedBody: unknown;
    server.use(
      http.post("/api/v1/users", async ({ request }) => {
        capturedBody = await request.json();
        return HttpResponse.json(makeAuthUser({ id: 9, email: "cara@example.com", name: "Cara" }), {
          status: 201,
        });
      }),
    );

    const user = userEvent.setup();
    renderWithProviders(<UserFormDialog open onOpenChange={() => {}} />);
    await user.type(screen.getByLabelText("Email"), "cara@example.com");
    await user.type(screen.getByLabelText("Name"), "Cara");
    await user.type(screen.getByLabelText("Password"), "password1");
    await user.click(screen.getByRole("button", { name: "Save" }));

    expect(capturedBody).toEqual({
      email: "cara@example.com",
      name: "Cara",
      // Not touched by the test, so this is the form's own default - the
      // least privileged level.
      access_level: "nurse",
      // The form's own default (userSchema.ts): the Read-only preset.
      permissions: permissionPreset("read_only"),
      // Always sent, explicitly null when the form says "Not linked".
      doctor_id: null,
      reception_staff_id: null,
      password: "password1",
    });
  });

  it("sends the chosen access level", async () => {
    let capturedBody: unknown;
    server.use(
      http.post("/api/v1/users", async ({ request }) => {
        capturedBody = await request.json();
        return HttpResponse.json(makeAuthUser({ id: 9 }), { status: 201 });
      }),
    );

    const user = userEvent.setup();
    renderWithProviders(<UserFormDialog open onOpenChange={() => {}} />);
    await user.type(screen.getByLabelText("Email"), "cara@example.com");
    await user.type(screen.getByLabelText("Name"), "Cara");
    await user.selectOptions(screen.getByLabelText("Access level"), "manager");
    await user.type(screen.getByLabelText("Password"), "password1");
    await user.click(screen.getByRole("button", { name: "Save" }));

    expect(capturedBody).toMatchObject({ access_level: "manager" });
  });

  it("does not submit with a too-short password - shows a client-side field error", async () => {
    let posted = false;
    server.use(
      http.post("/api/v1/users", () => {
        posted = true;
        return HttpResponse.json(makeAuthUser({ id: 1 }), { status: 201 });
      }),
    );

    const user = userEvent.setup();
    renderWithProviders(<UserFormDialog open onOpenChange={() => {}} />);
    await user.type(screen.getByLabelText("Email"), "cara@example.com");
    await user.type(screen.getByLabelText("Name"), "Cara");
    await user.type(screen.getByLabelText("Password"), "short");
    await user.click(screen.getByRole("button", { name: "Save" }));

    expect(await screen.findByText("Must be at least 8 characters")).toBeInTheDocument();
    expect(posted).toBe(false);
  });

  it("a 409 duplicate-email conflict is shown as a top-of-form banner", async () => {
    server.use(
      http.post("/api/v1/users", () =>
        HttpResponse.json({ detail: "Email 'cara@example.com' already exists" }, { status: 409 }),
      ),
    );

    const user = userEvent.setup();
    renderWithProviders(<UserFormDialog open onOpenChange={() => {}} />);
    await user.type(screen.getByLabelText("Email"), "cara@example.com");
    await user.type(screen.getByLabelText("Name"), "Cara");
    await user.type(screen.getByLabelText("Password"), "password1");
    await user.click(screen.getByRole("button", { name: "Save" }));

    expect(await screen.findByText("Email 'cara@example.com' already exists")).toBeInTheDocument();
  });
});

describe("UserFormDialog - edit mode", () => {
  it("pre-fills email/name, leaves password blank, and labels it 'New password'", async () => {
    const existingUser = makeAuthUser({
      id: 5,
      email: "ann@example.com",
      name: "Ann",
      access_level: "doctor",
    });

    renderWithProviders(<UserFormDialog user={existingUser} open onOpenChange={() => {}} />);

    expect(await screen.findByRole("heading", { name: "Edit Ann" })).toBeInTheDocument();
    expect(screen.getByLabelText("Email")).toHaveValue("ann@example.com");
    expect(screen.getByLabelText("Access level")).toHaveValue("doctor");
    expect(screen.getByLabelText("New password")).toHaveValue("");
    expect(screen.getByText(/Leave blank to keep the current password/)).toBeInTheDocument();
  });

  it("submits PATCH without a password field when left blank", async () => {
    const existingUser = makeAuthUser({ id: 5, email: "ann@example.com", name: "Ann" });
    let capturedBody: unknown;
    server.use(
      http.patch("/api/v1/users/5", async ({ request }) => {
        capturedBody = await request.json();
        return HttpResponse.json(existingUser);
      }),
    );

    const user = userEvent.setup();
    renderWithProviders(<UserFormDialog user={existingUser} open onOpenChange={() => {}} />);
    await screen.findByLabelText("Email");
    await user.click(screen.getByRole("button", { name: "Save" }));

    expect(capturedBody).toEqual({
      email: "ann@example.com",
      name: "Ann",
      access_level: "manager",
      // Re-sent unchanged: the form was seeded with the user's own set.
      permissions: { ...PERMISSION_PRESETS.manager },
      doctor_id: null,
      reception_staff_id: null,
    });
  });

  it("submits PATCH with a new password when one is entered", async () => {
    const existingUser = makeAuthUser({ id: 5, email: "ann@example.com", name: "Ann" });
    let capturedBody: unknown;
    server.use(
      http.patch("/api/v1/users/5", async ({ request }) => {
        capturedBody = await request.json();
        return HttpResponse.json(existingUser);
      }),
    );

    const user = userEvent.setup();
    renderWithProviders(<UserFormDialog user={existingUser} open onOpenChange={() => {}} />);
    await user.type(screen.getByLabelText("New password"), "newpassword1");
    await user.click(screen.getByRole("button", { name: "Save" }));

    expect(capturedBody).toEqual({
      email: "ann@example.com",
      name: "Ann",
      access_level: "manager",
      permissions: { ...PERMISSION_PRESETS.manager },
      doctor_id: null,
      reception_staff_id: null,
      password: "newpassword1",
    });
  });
});

describe("UserFormDialog - staff links", () => {
  it("pre-fills an existing link and marks an inactive one", async () => {
    const existingUser = makeAuthUser({
      id: 5,
      name: "Ann",
      linked_doctor: { id: 3, code: "AB", active: false },
      linked_reception_staff: { id: 7, code: "Emily M", active: true },
    });
    setUpStaff({
      doctors: [makeDoctor({ id: 3, code: "AB", active: false })],
      receptionStaff: [makeReceptionStaff({ id: 7, code: "Emily M" })],
      users: [existingUser],
    });

    renderWithProviders(<UserFormDialog user={existingUser} open onOpenChange={() => {}} />);

    expect(await screen.findByRole("option", { name: "AB (inactive)" })).toBeInTheDocument();
    await waitFor(() => expect(screen.getByLabelText("Linked doctor")).toHaveValue("3"));
    expect(screen.getByLabelText("Linked reception staff")).toHaveValue("7");
  });

  it("sends the chosen doctor id, and leaves the access level alone", async () => {
    setUpStaff({ doctors: [makeDoctor({ id: 3, code: "AB" })] });
    let capturedBody: unknown;
    server.use(
      http.post("/api/v1/users", async ({ request }) => {
        capturedBody = await request.json();
        return HttpResponse.json(makeAuthUser({ id: 9 }), { status: 201 });
      }),
    );

    const user = userEvent.setup();
    renderWithProviders(<UserFormDialog open onOpenChange={() => {}} />);
    await screen.findByRole("option", { name: "AB" });
    await user.type(screen.getByLabelText("Email"), "cara@example.com");
    await user.type(screen.getByLabelText("Name"), "Cara");
    await user.type(screen.getByLabelText("Password"), "password1");
    await user.selectOptions(screen.getByLabelText("Linked doctor"), "3");

    // Identity and permission are orthogonal - picking a doctor must not
    // nudge the access level towards "doctor".
    expect(screen.getByLabelText("Access level")).toHaveValue("nurse");

    await user.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() =>
      expect(capturedBody).toMatchObject({ doctor_id: 3, reception_staff_id: null, access_level: "nurse" }),
    );
  });

  it("choosing 'Not linked' on a linked user PATCHes an explicit null", async () => {
    const existingUser = makeAuthUser({
      id: 5,
      email: "ann@example.com",
      name: "Ann",
      linked_doctor: { id: 3, code: "AB", active: true },
    });
    setUpStaff({ doctors: [makeDoctor({ id: 3, code: "AB" })], users: [existingUser] });
    let capturedBody: unknown;
    server.use(
      http.patch("/api/v1/users/5", async ({ request }) => {
        capturedBody = await request.json();
        return HttpResponse.json(existingUser);
      }),
    );

    const user = userEvent.setup();
    renderWithProviders(<UserFormDialog user={existingUser} open onOpenChange={() => {}} />);
    await waitFor(() => expect(screen.getByLabelText("Linked doctor")).toHaveValue("3"));

    await user.selectOptions(screen.getByLabelText("Linked doctor"), "");
    await user.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(capturedBody).toMatchObject({ doctor_id: null }));
  });

  it("hides a doctor claimed by another user but keeps this user's own link", async () => {
    const editedUser = makeAuthUser({
      id: 5,
      name: "Ann",
      linked_doctor: { id: 3, code: "AB", active: true },
    });
    const otherUser = makeAuthUser({
      id: 6,
      name: "Bob",
      linked_doctor: { id: 4, code: "CD", active: true },
    });
    setUpStaff({
      doctors: [makeDoctor({ id: 3, code: "AB" }), makeDoctor({ id: 4, code: "CD" })],
      users: [editedUser, otherUser],
    });

    renderWithProviders(<UserFormDialog user={editedUser} open onOpenChange={() => {}} />);

    expect(await screen.findByRole("option", { name: "AB" })).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByRole("option", { name: "CD" })).not.toBeInTheDocument());
  });

  it("surfaces the server's 409 for an already-claimed staff row as a form banner", async () => {
    setUpStaff({ doctors: [makeDoctor({ id: 3, code: "AB" })] });
    server.use(
      http.post("/api/v1/users", () =>
        HttpResponse.json({ detail: "Doctor 'AB' is already linked to another user" }, { status: 409 }),
      ),
    );

    const user = userEvent.setup();
    renderWithProviders(<UserFormDialog open onOpenChange={() => {}} />);
    await screen.findByRole("option", { name: "AB" });
    await user.type(screen.getByLabelText("Email"), "cara@example.com");
    await user.type(screen.getByLabelText("Name"), "Cara");
    await user.type(screen.getByLabelText("Password"), "password1");
    await user.selectOptions(screen.getByLabelText("Linked doctor"), "3");
    await user.click(screen.getByRole("button", { name: "Save" }));

    expect(
      await screen.findByText("Doctor 'AB' is already linked to another user"),
    ).toBeInTheDocument();
  });
});
/** The radios for one area, which share their option labels across groups. */
function areaGroup(name: string) {
  return within(screen.getByRole("group", { name }));
}

describe("UserFormDialog - permissions", () => {
  it("a new user starts on the Read-only preset", async () => {
    renderWithProviders(<UserFormDialog open onOpenChange={() => {}} />);

    await screen.findByRole("heading", { name: "New User" });
    expect(areaGroup("Clinical rota").getByRole("radio", { name: "Read only" })).toBeChecked();
    expect(areaGroup("Reception rota").getByRole("radio", { name: "Read only" })).toBeChecked();
    expect(screen.getByRole("checkbox", { name: "Signatures" })).not.toBeChecked();
  });

  it("a preset button fills every control", async () => {
    const user = userEvent.setup();
    renderWithProviders(<UserFormDialog open onOpenChange={() => {}} />);
    await screen.findByRole("heading", { name: "New User" });

    await user.click(screen.getByRole("button", { name: "Reception admin" }));

    expect(areaGroup("Clinical rota").getByRole("radio", { name: "Read only" })).toBeChecked();
    expect(areaGroup("Reception rota").getByRole("radio", { name: "Can edit" })).toBeChecked();
    expect(screen.getByRole("button", { name: "Reception admin" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  });

  // A preset is a starting point, not a stored value: once a control moves
  // away from it, the row must stop claiming to describe the set.
  it("touching a control clears the selected preset", async () => {
    const user = userEvent.setup();
    renderWithProviders(<UserFormDialog open onOpenChange={() => {}} />);
    await screen.findByRole("heading", { name: "New User" });

    await user.click(screen.getByRole("button", { name: "Manager" }));
    await user.click(screen.getByRole("checkbox", { name: "Signatures" }));

    expect(screen.getByRole("button", { name: "Manager" })).toHaveAttribute("aria-pressed", "false");
    expect(screen.getByRole("checkbox", { name: "Signatures" })).not.toBeChecked();
  });

  it("sends the edited set on create", async () => {
    let capturedBody: unknown;
    server.use(
      http.post("/api/v1/users", async ({ request }) => {
        capturedBody = await request.json();
        return HttpResponse.json(makeAuthUser({ id: 9 }), { status: 201 });
      }),
    );

    const user = userEvent.setup();
    renderWithProviders(<UserFormDialog open onOpenChange={() => {}} />);
    await user.type(screen.getByLabelText("Email"), "cara@example.com");
    await user.type(screen.getByLabelText("Name"), "Cara");
    await user.type(screen.getByLabelText("Password"), "password1");
    await user.click(screen.getByRole("button", { name: "Rota admin" }));
    await user.click(screen.getByRole("checkbox", { name: "Study EOI" }));
    await user.click(areaGroup("Reception rota").getByRole("radio", { name: "None" }));
    await user.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() =>
      expect(capturedBody).toMatchObject({
        permissions: {
          clinical: "write",
          reception: "none",
          signatures: false,
          study_eoi: true,
          user_admin: false,
        },
      }),
    );
  });

  it("pre-fills an existing user's set and PATCHes the change", async () => {
    const existingUser = makeAuthUser({
      id: 5,
      name: "Ann",
      permissions: { ...PERMISSION_PRESETS.receptionAdmin },
    });
    setUpStaff({ users: [existingUser] });
    let capturedBody: unknown;
    server.use(
      http.patch("/api/v1/users/5", async ({ request }) => {
        capturedBody = await request.json();
        return HttpResponse.json(existingUser);
      }),
    );

    const user = userEvent.setup();
    renderWithProviders(<UserFormDialog user={existingUser} open onOpenChange={() => {}} />);
    await screen.findByRole("heading", { name: "Edit Ann" });
    expect(areaGroup("Reception rota").getByRole("radio", { name: "Can edit" })).toBeChecked();

    await user.click(areaGroup("Clinical rota").getByRole("radio", { name: "Can edit" }));
    await user.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() =>
      expect(capturedBody).toMatchObject({
        permissions: { ...PERMISSION_PRESETS.receptionAdmin, clinical: "write" },
      }),
    );
  });

  it("refuses to save a set that grants nothing, without a request", async () => {
    let posted = false;
    server.use(
      http.post("/api/v1/users", () => {
        posted = true;
        return HttpResponse.json(makeAuthUser({ id: 1 }), { status: 201 });
      }),
    );

    const user = userEvent.setup();
    renderWithProviders(<UserFormDialog open onOpenChange={() => {}} />);
    await user.type(screen.getByLabelText("Email"), "cara@example.com");
    await user.type(screen.getByLabelText("Name"), "Cara");
    await user.type(screen.getByLabelText("Password"), "password1");
    await user.click(areaGroup("Clinical rota").getByRole("radio", { name: "None" }));
    await user.click(areaGroup("Reception rota").getByRole("radio", { name: "None" }));
    await user.click(screen.getByRole("button", { name: "Save" }));

    expect(await screen.findByText(/needs at least one permission/)).toBeInTheDocument();
    expect(posted).toBe(false);
  });

  /**
   * The regression guard for the shared-read allowlist (plan D6a): GET
   * /doctors and GET /reception/staff are readable without the clinical or
   * reception permission *because* this dialog needs them. A user_admin-only
   * login is exactly the tightly scoped login the feature exists to make
   * possible, and if that allowlist is ever tightened, both pickers here go
   * empty and this test fails.
   */
  it("populates both staff pickers for a user_admin-only login", async () => {
    setUpStaff({
      doctors: [makeDoctor({ id: 3, code: "AB" })],
      receptionStaff: [makeReceptionStaff({ id: 7, code: "Emily M" })],
    });

    renderWithProviders(<UserFormDialog open onOpenChange={() => {}} />, {
      permissions: {
        clinical: "none",
        reception: "none",
        signatures: false,
        study_eoi: false,
        user_admin: true,
      },
    });

    expect(
      await within(screen.getByLabelText("Linked doctor")).findByRole("option", { name: "AB" }),
    ).toBeInTheDocument();
    expect(
      await within(screen.getByLabelText("Linked reception staff")).findByRole("option", {
        name: "Emily M",
      }),
    ).toBeInTheDocument();
  });
});
