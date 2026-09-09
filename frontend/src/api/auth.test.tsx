import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import { HttpResponse, http } from "msw";
import type { ReactNode } from "react";
import { describe, expect, it } from "vitest";

import { server } from "@/test/msw/server";

import { useLogin, useLogout, useMe } from "./auth";

function makeWrapper(queryClient: QueryClient) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
  };
}

function freshClient() {
  return new QueryClient({ defaultOptions: { queries: { retry: false } } });
}

const AUTH_USER = {
  id: 1,
  email: "jo@example.com",
  name: "Jo Bloggs",
  active: true,
  created_at: "2026-07-01T00:00:00Z",
};

describe("useLogin", () => {
  it("posts credentials and returns the token and user", async () => {
    let capturedBody: unknown;
    server.use(
      http.post("/api/v1/auth/login", async ({ request }) => {
        capturedBody = await request.json();
        return HttpResponse.json({ token: "new-session-token", user: AUTH_USER });
      }),
    );

    const { result } = renderHook(() => useLogin(), { wrapper: makeWrapper(freshClient()) });
    result.current.mutate({ email: "jo@example.com", password: "hunter22" });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(capturedBody).toEqual({ email: "jo@example.com", password: "hunter22" });
    expect(result.current.data).toEqual({ token: "new-session-token", user: AUTH_USER });
  });

  it("surfaces a 401 as an ApiError on bad credentials", async () => {
    server.use(
      http.post("/api/v1/auth/login", () =>
        HttpResponse.json({ detail: "Invalid email or password" }, { status: 401 }),
      ),
    );

    const { result } = renderHook(() => useLogin(), { wrapper: makeWrapper(freshClient()) });
    result.current.mutate({ email: "jo@example.com", password: "wrong" });

    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(result.current.error).toMatchObject({ status: 401 });
  });
});

describe("useLogout", () => {
  it("posts to /auth/logout", async () => {
    let called = false;
    server.use(
      http.post("/api/v1/auth/logout", () => {
        called = true;
        return new HttpResponse(null, { status: 204 });
      }),
    );

    const { result } = renderHook(() => useLogout(), { wrapper: makeWrapper(freshClient()) });
    result.current.mutate();

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(called).toBe(true);
  });
});

describe("useMe", () => {
  it("does not fire the request when enabled is false", async () => {
    let called = false;
    server.use(
      http.get("/api/v1/auth/me", () => {
        called = true;
        return HttpResponse.json(AUTH_USER);
      }),
    );

    renderHook(() => useMe(false), { wrapper: makeWrapper(freshClient()) });

    // No await-able success/failure state to wait on since the query never
    // runs - a short flush is enough to prove the handler was never hit.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(called).toBe(false);
  });

  it("fetches the current user when enabled", async () => {
    server.use(http.get("/api/v1/auth/me", () => HttpResponse.json(AUTH_USER)));

    const { result } = renderHook(() => useMe(true), { wrapper: makeWrapper(freshClient()) });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toEqual(AUTH_USER);
  });

  it("surfaces a 401 without retrying", async () => {
    let callCount = 0;
    server.use(
      http.get("/api/v1/auth/me", () => {
        callCount += 1;
        return HttpResponse.json({ detail: "Not authenticated" }, { status: 401 });
      }),
    );

    const { result } = renderHook(() => useMe(true), { wrapper: makeWrapper(freshClient()) });

    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(callCount).toBe(1);
  });
});