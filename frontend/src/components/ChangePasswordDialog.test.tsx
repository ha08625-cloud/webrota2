import { HttpResponse, http } from "msw";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { onUnauthorized } from "@/api/client";
import { clearToken, getToken, setToken } from "@/auth/tokenStore";
import { makeAuthUser } from "@/test/fixtures/reference";
import { renderWithProviders } from "@/test/renderWithProviders";
import { server } from "@/test/msw/server";

import { ChangePasswordDialog } from "./ChangePasswordDialog";

async function openDialog() {
  const user = userEvent.setup();
  renderWithProviders(<ChangePasswordDialog />);
  await user.click(screen.getByRole("button", { name: "Change password" }));
  await screen.findByRole("heading", { name: "Change password" });
  return user;
}

describe("ChangePasswordDialog", () => {
  afterEach(() => {
    clearToken();
    onUnauthorized(null);
  });

  it("rejects a password shorter than the backend's minimum without calling the API", async () => {
    let called = false;
    server.use(
      http.patch("/api/v1/users/me", () => {
        called = true;
        return HttpResponse.json(makeAuthUser());
      }),
    );

    const user = await openDialog();
    await user.type(screen.getByLabelText("New password"), "short");
    await user.type(screen.getByLabelText("Confirm new password"), "short");
    await user.click(screen.getByRole("button", { name: "Save" }));

    expect(await screen.findByText("Must be at least 8 characters")).toBeInTheDocument();
    expect(called).toBe(false);
  });

  it("rejects a mismatched confirmation without calling the API", async () => {
    let called = false;
    server.use(
      http.patch("/api/v1/users/me", () => {
        called = true;
        return HttpResponse.json(makeAuthUser());
      }),
    );

    const user = await openDialog();
    await user.type(screen.getByLabelText("New password"), "password1");
    await user.type(screen.getByLabelText("Confirm new password"), "password2");
    await user.click(screen.getByRole("button", { name: "Save" }));

    expect(await screen.findByText("The two passwords do not match.")).toBeInTheDocument();
    expect(called).toBe(false);
  });

  it("PATCHes /users/me with the password only", async () => {
    let capturedBody: unknown;
    server.use(
      http.patch("/api/v1/users/me", async ({ request }) => {
        capturedBody = await request.json();
        return HttpResponse.json(makeAuthUser());
      }),
    );

    const user = await openDialog();
    await user.type(screen.getByLabelText("New password"), "password1");
    await user.type(screen.getByLabelText("Confirm new password"), "password1");
    await user.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(capturedBody).toEqual({ password: "password1" }));
  });

  it("signs the user out with a reason, since the backend has deleted every session", async () => {
    setToken("session-token");
    const listener = vi.fn();
    onUnauthorized(listener);
    server.use(http.patch("/api/v1/users/me", () => HttpResponse.json(makeAuthUser())));

    const user = await openDialog();
    await user.type(screen.getByLabelText("New password"), "password1");
    await user.type(screen.getByLabelText("Confirm new password"), "password1");
    await user.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(listener).toHaveBeenCalledOnce());
    expect(listener.mock.calls[0][0]).toMatch(/password was changed/i);
    expect(getToken()).toBeNull();
  });

  it("shows a server rejection in the dialog rather than signing the user out", async () => {
    setToken("session-token");
    server.use(
      http.patch("/api/v1/users/me", () =>
        HttpResponse.json({ detail: "Password is too common" }, { status: 422 }),
      ),
    );

    const user = await openDialog();
    await user.type(screen.getByLabelText("New password"), "password1");
    await user.type(screen.getByLabelText("Confirm new password"), "password1");
    await user.click(screen.getByRole("button", { name: "Save" }));

    expect(await screen.findByText("Password is too common")).toBeInTheDocument();
    expect(getToken()).toBe("session-token");
  });
});
