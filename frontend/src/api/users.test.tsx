import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import { HttpResponse, http } from "msw";
import type { ReactNode } from "react";
import { describe, expect, it } from "vitest";

import { server } from "@/test/msw/server";
import { makeAuthUser } from "@/test/fixtures/reference";

import { useCreateUser, useUpdateUser, useUsers } from "./users";

function makeWrapper(queryClient: QueryClient) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
  };
}

function freshClient() {
  return new QueryClient({ defaultOptions: { queries: { retry: false } } });
}

describe("useUsers", () => {
  it("fetches the full user list, active and inactive alike", async () => {
    server.use(
      http.get("/api/v1/users", () =>
        HttpResponse.json([
          makeAuthUser({ id: 1, name: "Ann" }),
          makeAuthUser({ id: 2, name: "Bob", active: false }),
        ]),
      ),
    );

    const { result } = renderHook(() => useUsers(), { wrapper: makeWrapper(freshClient()) });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toHaveLength(2);
  });
});

describe("useCreateUser", () => {
  it("posts to /users", async () => {
    let capturedBody: unknown;
    server.use(
      http.post("/api/v1/users", async ({ request }) => {
        capturedBody = await request.json();
        return HttpResponse.json(makeAuthUser({ id: 9, name: "Cara" }), { status: 201 });
      }),
    );

    const { result } = renderHook(() => useCreateUser(), { wrapper: makeWrapper(freshClient()) });
    result.current.mutate({ email: "cara@example.com", name: "Cara", password: "password1" });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(capturedBody).toEqual({ email: "cara@example.com", name: "Cara", password: "password1" });
  });
});

describe("useUpdateUser", () => {
  it("PATCHes the given user id with only the supplied fields", async () => {
    let capturedBody: unknown;
    let capturedUrl = "";
    server.use(
      http.patch("/api/v1/users/5", async ({ request }) => {
        capturedUrl = request.url;
        capturedBody = await request.json();
        return HttpResponse.json(makeAuthUser({ id: 5, active: false }));
      }),
    );

    const { result } = renderHook(() => useUpdateUser(), { wrapper: makeWrapper(freshClient()) });
    result.current.mutate({ id: 5, payload: { active: false } });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(capturedUrl).toContain("/api/v1/users/5");
    expect(capturedBody).toEqual({ active: false });
  });

  it("surfaces a 409 (last active user) as an ApiError with status 409", async () => {
    server.use(
      http.patch("/api/v1/users/5", () =>
        HttpResponse.json({ detail: "cannot deactivate the last active user" }, { status: 409 }),
      ),
    );

    const { result } = renderHook(() => useUpdateUser(), { wrapper: makeWrapper(freshClient()) });
    result.current.mutate({ id: 5, payload: { active: false } });

    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(result.current.error?.status).toBe(409);
  });
});