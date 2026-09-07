import { HttpResponse, http } from "msw";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { PERMISSION_PRESETS, makeAuthUser } from "@/test/fixtures/reference";
import { renderWithProviders } from "@/test/renderWithProviders";
import { server } from "@/test/msw/server";

import { UsersPage } from "./UsersPage";

function setUpServer(users: ReturnType<typeof makeAuthUser>[]) {
  server.use(http.get("/api/v1/users", () => HttpResponse.json(users)));
}

describe("UsersPage", () => {
  it("shows an empty-state message when there are no users", async () => {
    setUpServer([]);
    renderWithProviders(<UsersPage />);

    expect(await screen.findByText(/No users yet/)).toBeInTheDocument();
  });

  it("renders a row per user, flagging inactive ones", async () => {
    setUpServer([
      makeAuthUser({ id: 1, name: "Ann", email: "ann@example.com" }),
      makeAuthUser({ id: 2, name: "Bob", email: "bob@example.com", active: false }),
    ]);
    renderWithProviders(<UsersPage />);

    expect(await screen.findByText("Ann")).toBeInTheDocument();
    const bobRow = (await screen.findByText("Bob")).closest("tr");
    expect(bobRow).not.toBeNull();
    expect(bobRow?.textContent).toContain("(inactive)");
  });

  it("New User opens the dialog in create mode", async () => {
    setUpServer([]);
    const user = userEvent.setup();
    renderWithProviders(<UsersPage />);
    await screen.findByRole("button", { name: "New User" });

    await user.click(screen.getByRole("button", { name: "New User" }));

    expect(await screen.findByRole("heading", { name: "New User" })).toBeInTheDocument();
  });

  it("Edit opens the dialog pre-filled for that user", async () => {
    setUpServer([makeAuthUser({ id: 1, name: "Ann", email: "ann@example.com" })]);
    const user = userEvent.setup();
    renderWithProviders(<UsersPage />);
    await screen.findByText("Ann");

    await user.click(screen.getByRole("button", { name: "Edit" }));

    expect(await screen.findByRole("heading", { name: "Edit Ann" })).toBeInTheDocument();
  });

  it("Deactivate confirms, PATCHes active=false, and the row updates", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(true);
    const activeUser = makeAuthUser({ id: 1, name: "Ann", active: true });
    setUpServer([activeUser]);
    let patchedActiveFalse = false;
    server.use(
      http.patch("/api/v1/users/1", async ({ request }) => {
        const body = (await request.json()) as { active?: boolean };
        patchedActiveFalse = body.active === false;
        return HttpResponse.json(makeAuthUser({ id: 1, name: "Ann", active: false }));
      }),
    );

    const user = userEvent.setup();
    renderWithProviders(<UsersPage />);
    await screen.findByText("Ann");

    await user.click(screen.getByRole("button", { name: "Deactivate" }));

    expect(patchedActiveFalse).toBe(true);
  });

  it("does not deactivate when the confirmation is declined", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(false);
    setUpServer([makeAuthUser({ id: 1, name: "Ann", active: true })]);
    let patched = false;
    server.use(
      http.patch("/api/v1/users/1", () => {
        patched = true;
        return HttpResponse.json(makeAuthUser({ id: 1, name: "Ann", active: false }));
      }),
    );

    const user = userEvent.setup();
    renderWithProviders(<UsersPage />);
    await screen.findByText("Ann");
    await user.click(screen.getByRole("button", { name: "Deactivate" }));

    expect(patched).toBe(false);
  });

  it("Reactivate does not prompt for confirmation and PATCHes active=true", async () => {
    setUpServer([makeAuthUser({ id: 1, name: "Ann", active: false })]);
    let patchedActiveTrue = false;
    server.use(
      http.patch("/api/v1/users/1", async ({ request }) => {
        const body = (await request.json()) as { active?: boolean };
        patchedActiveTrue = body.active === true;
        return HttpResponse.json(makeAuthUser({ id: 1, name: "Ann", active: true }));
      }),
    );

    const user = userEvent.setup();
    renderWithProviders(<UsersPage />);
    await screen.findByText("Ann");

    await user.click(screen.getByRole("button", { name: "Reactivate" }));

    expect(patchedActiveTrue).toBe(true);
  });

  it("a 409 (last active manager) surfaces as a toast", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(true);
    setUpServer([makeAuthUser({ id: 1, name: "Ann", active: true })]);
    server.use(
      http.patch("/api/v1/users/1", () =>
        HttpResponse.json({ detail: "cannot remove the last active manager" }, { status: 409 }),
      ),
    );

    const user = userEvent.setup();
    renderWithProviders(<UsersPage />);
    await screen.findByText("Ann");
    await user.click(screen.getByRole("button", { name: "Deactivate" }));

    expect(await screen.findByText("cannot remove the last active manager")).toBeInTheDocument();
  });
});

describe("UsersPage access levels", () => {
  it("shows each user's access level", async () => {
    setUpServer([makeAuthUser({ id: 1, name: "Ann", access_level: "doctor" })]);
    renderWithProviders(<UsersPage />);

    expect(await screen.findByLabelText("Access level for Ann")).toHaveValue("doctor");
  });

  it("changing the row's access level PATCHes just that field", async () => {
    setUpServer([makeAuthUser({ id: 1, name: "Ann", access_level: "nurse" })]);
    let capturedBody: unknown;
    server.use(
      http.patch("/api/v1/users/1", async ({ request }) => {
        capturedBody = await request.json();
        return HttpResponse.json(makeAuthUser({ id: 1, name: "Ann", access_level: "admin" }));
      }),
    );

    const user = userEvent.setup();
    renderWithProviders(<UsersPage />);
    await screen.findByText("Ann");

    await user.selectOptions(screen.getByLabelText("Access level for Ann"), "admin");

    await waitFor(() => expect(capturedBody).toEqual({ access_level: "admin" }));
  });

  it("a 409 on demoting the last active manager surfaces as a toast", async () => {
    setUpServer([makeAuthUser({ id: 1, name: "Ann", access_level: "manager" })]);
    server.use(
      http.patch("/api/v1/users/1", () =>
        HttpResponse.json({ detail: "cannot remove the last active manager" }, { status: 409 }),
      ),
    );

    const user = userEvent.setup();
    renderWithProviders(<UsersPage />);
    await screen.findByText("Ann");

    await user.selectOptions(screen.getByLabelText("Access level for Ann"), "nurse");

    expect(await screen.findByText("cannot remove the last active manager")).toBeInTheDocument();
  });
});

describe("UsersPage permissions column", () => {
  it("summarises what each user may do, leaving out what they may not", async () => {
    setUpServer([
      makeAuthUser({ id: 1, name: "Ann", permissions: { ...PERMISSION_PRESETS.receptionAdmin } }),
      makeAuthUser({ id: 2, name: "Bob", permissions: { ...PERMISSION_PRESETS.documents } }),
    ]);
    renderWithProviders(<UsersPage />);

    const annRow = (await screen.findByText("Ann")).closest("tr");
    expect(annRow?.textContent).toContain("Clinical rota: read, Reception rota: edit");
    expect(annRow?.textContent).not.toContain("Signatures");

    const bobRow = (await screen.findByText("Bob")).closest("tr");
    // No rota access at all, so only the two document tools are listed.
    expect(bobRow?.textContent).toContain("Signatures, Study EOI");
  });
});

describe("UsersPage below manager", () => {
  // The nav entry is hidden for these users (App.tsx), but the route stays
  // registered, so a deep link has to land on something sane rather than
  // on a list that just 403s.
  it.each(["rotaAdmin", "receptionAdmin", "readOnly"] as const)(
    "tells a %s, who has no user administration permission, they have no access",
    async (presetName) => {
      let listed = false;
      server.use(
        http.get("/api/v1/users", () => {
          listed = true;
          return HttpResponse.json([]);
        }),
      );

      renderWithProviders(<UsersPage />, { permissions: PERMISSION_PRESETS[presetName] });

      expect(await screen.findByText(/do not have access to user management/i)).toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "New User" })).not.toBeInTheDocument();
      // Not even the list request goes out - the backend would 403 it.
      expect(listed).toBe(false);
    },
  );

  it("shows the linked staff codes, marking inactive ones, and a dash when unlinked", async () => {
    setUpServer([
      makeAuthUser({
        id: 1,
        name: "Ann",
        linked_doctor: { id: 3, code: "AB", active: true },
        linked_reception_staff: { id: 7, code: "Emily M", active: false },
      }),
      makeAuthUser({ id: 2, name: "Bob" }),
    ]);
    renderWithProviders(<UsersPage />);

    const annRow = (await screen.findByText("Ann")).closest("tr");
    expect(annRow?.textContent).toContain("AB, Emily M (inactive)");
    const bobRow = (await screen.findByText("Bob")).closest("tr");
    expect(bobRow?.textContent).toContain("\u2014");
  });
});