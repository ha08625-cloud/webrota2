import { afterEach, describe, expect, it, vi } from "vitest";

import { HttpResponse, http } from "msw";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { apiClient } from "@/api/client";
import { server } from "@/test/msw/server";

import { clearToken, getToken, setToken } from "./tokenStore";
import { LoginGate } from "./LoginGate";

const AUTH_USER = {
  id: 1,
  email: "jo@example.com",
  name: "Jo Bloggs",
  active: true,
  created_at: "2026-07-01T00:00:00Z",
};

function renderGate() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const resetSpy = vi.spyOn(queryClient, "resetQueries");
  render(
    <QueryClientProvider client={queryClient}>
      <LoginGate>
        <div>protected content</div>
      </LoginGate>
    </QueryClientProvider>,
  );
  return { resetSpy };
}

describe("LoginGate", () => {
  afterEach(() => {
    clearToken();
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
});
