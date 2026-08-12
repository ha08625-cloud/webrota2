import { HttpResponse, http } from "msw";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";

import { makeAuthUser } from "@/test/fixtures/reference";
import { renderWithProviders } from "@/test/renderWithProviders";
import { server } from "@/test/msw/server";

import { UserFormDialog } from "./UserFormDialog";

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
      // least privileged level (role-based auth, Design Decision 7).
      access_level: "nurse",
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
      password: "newpassword1",
    });
  });
});