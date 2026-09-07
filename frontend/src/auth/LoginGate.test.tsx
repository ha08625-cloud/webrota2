import { afterEach, describe, expect, it, vi } from "vitest";

import { HttpResponse, http } from "msw";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { apiClient, triggerUnauthorized } from "@/api/client";
import { server } from "@/test/msw/server";

import { useAuth } from "./AuthContext";
import { clearToken, getToken, setToken } from "./tokenStore";
import { LoginGate } from "./LoginGate";

const AUTH_USER = {
  id: 1,
  email: "jo@example.com",
  name: "Jo Bloggs",
  active: true,
  access_level: "admin",
  permissions: {
    clinical: "write",
    reception: "write",
    signatures: false,
    study_eoi: false,
    user_admin: false,
  },
  created_at: "2026-07-01T00:00:00Z",
};

/** Reads what LoginGate published to the auth context. */
function AccessProbe() {
  const { user, permissions } = useAuth();
  return (
    <div>
      protected content
      <span data-testid="probe-level">{user?.access_level ?? "none"}</span>
      <span data-testid="probe-clinical">{permissions.clinical}</span>
    </div>
  );
}

function renderGate() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const resetSpy = vi.spyOn(queryClient, "resetQueries");
  render(
    <QueryClientProvider client={queryClient}>
      <LoginGate>
        <AccessProbe />
      </LoginGate>
    </QueryClientProvider>,
  );
  return { resetSpy };
}

describe("LoginGate", () => {
  afterEach(() => {
    clearToken();
    // Every test that lands on a reset link changes the URL; leaving it
    // there would put the next test straight into the reset view.
    window.history.replaceState(null, "", "/");
  });

  it("shows the login form immediately when there is no stored token, without calling /auth/me", async () => {
    let meCalled = false;
    server.use(
      http.get("/api/v1/auth/me", () => {
        meCalled = true;
        return HttpResponse.json(AUTH_USER);
      }),
    );

    renderGate();

    expect(await screen.findByRole("heading", { name: "Log in" })).toBeInTheDocument();
    expect(screen.queryByText("protected content")).not.toBeInTheDocument();
    expect(meCalled).toBe(false);
  });

  it("renders children when a stored token checks out against /auth/me", async () => {
    setToken("valid-token");
    server.use(http.get("/api/v1/auth/me", () => HttpResponse.json(AUTH_USER)));

    renderGate();

    expect(await screen.findByText("protected content")).toBeInTheDocument();
  });

  it("clears a stale token and shows the login form when /auth/me 401s", async () => {
    setToken("stale-token");
    server.use(
      http.get("/api/v1/auth/me", () =>
        HttpResponse.json({ detail: "Not authenticated" }, { status: 401 }),
      ),
    );

    renderGate();

    expect(await screen.findByRole("heading", { name: "Log in" })).toBeInTheDocument();
    expect(getToken()).toBeNull();
  });

  it("stores the token and resets queries on successful login", async () => {
    server.use(
      http.post("/api/v1/auth/login", () =>
        HttpResponse.json({ token: "new-session-token", user: AUTH_USER }),
      ),
    );

    const { resetSpy } = renderGate();
    const user = userEvent.setup();

    await user.type(await screen.findByLabelText("Email"), "jo@example.com");
    await user.type(screen.getByLabelText("Password"), "correct-password");
    await user.click(screen.getByRole("button", { name: "Log in" }));

    await waitFor(() => expect(screen.getByText("protected content")).toBeInTheDocument());
    expect(getToken()).toBe("new-session-token");
    expect(resetSpy).toHaveBeenCalledOnce();
  });

  it("shows an error and stays on the login form when login fails", async () => {
    server.use(
      http.post("/api/v1/auth/login", () =>
        HttpResponse.json({ detail: "Invalid email or password" }, { status: 401 }),
      ),
    );

    renderGate();
    const user = userEvent.setup();

    await user.type(await screen.findByLabelText("Email"), "jo@example.com");
    await user.type(screen.getByLabelText("Password"), "wrong-password");
    await user.click(screen.getByRole("button", { name: "Log in" }));

    expect(await screen.findByText("Invalid email or password.")).toBeInTheDocument();
    expect(screen.queryByText("protected content")).not.toBeInTheDocument();
    expect(getToken()).toBeNull();
  });

  it("publishes the /auth/me user's label and permissions to the auth context", async () => {
    setToken("valid-token");
    server.use(http.get("/api/v1/auth/me", () => HttpResponse.json(AUTH_USER)));

    renderGate();

    expect(await screen.findByTestId("probe-level")).toHaveTextContent("admin");
    expect(screen.getByTestId("probe-clinical")).toHaveTextContent("write");
  });

  it("publishes the login response's user when there was no stored token to check", async () => {
    server.use(
      http.post("/api/v1/auth/login", () =>
        HttpResponse.json({
          token: "new-session-token",
          user: {
            ...AUTH_USER,
            access_level: "nurse",
            permissions: { ...AUTH_USER.permissions, clinical: "read", reception: "none" },
          },
        }),
      ),
    );

    renderGate();
    const user = userEvent.setup();
    await user.type(await screen.findByLabelText("Email"), "jo@example.com");
    await user.type(screen.getByLabelText("Password"), "correct-password");
    await user.click(screen.getByRole("button", { name: "Log in" }));

    expect(await screen.findByTestId("probe-level")).toHaveTextContent("nurse");
    expect(screen.getByTestId("probe-clinical")).toHaveTextContent("read");
  });

  it("shows the reason on the login form when the sign-out was expected", async () => {
    setToken("valid-token");
    server.use(http.get("/api/v1/auth/me", () => HttpResponse.json(AUTH_USER)));

    renderGate();
    await screen.findByText("protected content");

    // What ChangePasswordDialog does after a successful password change:
    // the backend has just deleted every session, this one included.
    triggerUnauthorized("Your password was changed. Please log in again.");

    expect(await screen.findByRole("status")).toHaveTextContent(
      "Your password was changed. Please log in again.",
    );
    expect(getToken()).toBeNull();
  });

  it("drops back to the login form on a mid-session 401 and clears the token", async () => {
    setToken("valid-token");
    server.use(http.get("/api/v1/auth/me", () => HttpResponse.json(AUTH_USER)));

    renderGate();
    expect(await screen.findByText("protected content")).toBeInTheDocument();

    server.use(
      http.get("/api/v1/health-check", () => HttpResponse.json({}, { status: 401 })),
    );
    await expect(apiClient.get("/health-check")).rejects.toMatchObject({ status: 401 });

    expect(await screen.findByRole("heading", { name: "Log in" })).toBeInTheDocument();
    expect(getToken()).toBeNull();
  });

  describe("password reset", () => {
    it("shows the forgot form from the login form and confirms without saying whether the address exists", async () => {
      renderGate();
      const user = userEvent.setup();

      await user.click(await screen.findByRole("button", { name: "Forgot password?" }));

      expect(
        await screen.findByRole("heading", { name: "Reset your password" }),
      ).toBeInTheDocument();
      await user.type(screen.getByLabelText("Email"), "jo@example.com");
      await user.click(screen.getByRole("button", { name: "Email me a link" }));

      const known = (await screen.findByRole("status")).textContent;
      expect(known).toContain("If that address is registered");
      // The one sentence that stops a typo becoming a silent dead end -
      // the backend matches the address exactly, so a wrong one is
      // indistinguishable from success.
      expect(known).toContain("the one you log in with");

      // The backend answers 204 for an unknown address too, so the
      // rendered confirmation must be byte-identical - anything else
      // would be the enumeration oracle the 204 exists to deny.
      cleanup();
      renderGate();
      await user.click(await screen.findByRole("button", { name: "Forgot password?" }));
      await user.type(await screen.findByLabelText("Email"), "nobody@example.com");
      await user.click(screen.getByRole("button", { name: "Email me a link" }));

      expect((await screen.findByRole("status")).textContent).toBe(known);
    });

    it("sends the address exactly as typed", async () => {
      let sent: unknown = null;
      server.use(
        http.post("/api/v1/auth/forgot-password", async ({ request }) => {
          sent = await request.json();
          return new HttpResponse(null, { status: 204 });
        }),
      );

      renderGate();
      const user = userEvent.setup();
      await user.click(await screen.findByRole("button", { name: "Forgot password?" }));
      await user.type(await screen.findByLabelText("Email"), "Jo@Example.com");
      await user.click(screen.getByRole("button", { name: "Email me a link" }));

      await waitFor(() => expect(sent).toEqual({ email: "Jo@Example.com" }));
    });

    it("shows the reset view on a reset link even when a stored token is valid", async () => {
      // The common case: a 30-day session is still live in this browser
      // and the user has forgotten the password they need elsewhere. If
      // the stored-token check won, they would be dropped into the app
      // and never see the reset form.
      setToken("valid-token");
      let meCalled = false;
      server.use(
        http.get("/api/v1/auth/me", () => {
          meCalled = true;
          return HttpResponse.json(AUTH_USER);
        }),
      );
      window.history.replaceState(null, "", "/reset-password/emailed-token");

      renderGate();

      expect(
        await screen.findByRole("heading", { name: "Set a new password" }),
      ).toBeInTheDocument();
      expect(screen.queryByText("protected content")).not.toBeInTheDocument();
      expect(meCalled).toBe(false);
      expect(getToken()).toBeNull();
    });

    it("posts the token from the URL and returns to the login form on success", async () => {
      let sent: unknown = null;
      server.use(
        http.post("/api/v1/auth/reset-password", async ({ request }) => {
          sent = await request.json();
          return new HttpResponse(null, { status: 204 });
        }),
      );
      window.history.replaceState(null, "", "/reset-password/emailed-token");

      renderGate();
      const user = userEvent.setup();

      await user.type(await screen.findByLabelText("New password"), "new-password");
      await user.type(screen.getByLabelText("Confirm new password"), "new-password");
      await user.click(screen.getByRole("button", { name: "Set new password" }));

      expect(await screen.findByRole("heading", { name: "Log in" })).toBeInTheDocument();
      expect(sent).toEqual({ token: "emailed-token", password: "new-password" });
      expect(await screen.findByRole("status")).toHaveTextContent(
        "Your password has been reset.",
      );
      // The spent token is off the URL, so a refresh does not re-submit it.
      expect(window.location.pathname).toBe("/");
    });

    it("renders the expiry message on a 400 and stays on the reset form", async () => {
      // A 401 here would fire apiClient's global onUnauthorized listener
      // and swap this view for a bare login form at the exact moment the
      // user needs to read why their link failed - which is why the
      // backend answers 400 and this test pins the consequence.
      window.history.replaceState(null, "", "/reset-password/stale-token");

      renderGate();
      const user = userEvent.setup();

      await user.type(await screen.findByLabelText("New password"), "new-password");
      await user.type(screen.getByLabelText("Confirm new password"), "new-password");
      await user.click(screen.getByRole("button", { name: "Set new password" }));

      expect(await screen.findByRole("alert")).toHaveTextContent(
        "This reset link is invalid or has expired.",
      );
      expect(screen.getByRole("heading", { name: "Set a new password" })).toBeInTheDocument();
      expect(screen.queryByRole("heading", { name: "Log in" })).not.toBeInTheDocument();
    });

    it("rejects a mismatched confirmation without calling the endpoint", async () => {
      let posted = false;
      server.use(
        http.post("/api/v1/auth/reset-password", () => {
          posted = true;
          return new HttpResponse(null, { status: 204 });
        }),
      );
      window.history.replaceState(null, "", "/reset-password/emailed-token");

      renderGate();
      const user = userEvent.setup();

      await user.type(await screen.findByLabelText("New password"), "new-password");
      await user.type(screen.getByLabelText("Confirm new password"), "different-password");
      await user.click(screen.getByRole("button", { name: "Set new password" }));

      expect(await screen.findByRole("alert")).toHaveTextContent(
        "The two passwords do not match.",
      );
      expect(posted).toBe(false);
    });
  });
});
