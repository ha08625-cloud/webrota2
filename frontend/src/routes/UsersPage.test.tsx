import { HttpResponse, http } from "msw";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { makeAuthUser } from "@/test/fixtures/reference";
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

  it("a 409 (last active user) surfaces as a toast", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(true);
    setUpServer([makeAuthUser({ id: 1, name: "Ann", active: true })]);
    server.use(
      http.patch("/api/v1/users/1", () =>
        HttpResponse.json({ detail: "cannot deactivate the last active user" }, { status: 409 }),
      ),
    );

    const user = userEvent.setup();
    renderWithProviders(<UsersPage />);
    await screen.findByText("Ann");
    await user.click(screen.getByRole("button", { name: "Deactivate" }));

    expect(await screen.findByText("cannot deactivate the last active user")).toBeInTheDocument();
  });
});