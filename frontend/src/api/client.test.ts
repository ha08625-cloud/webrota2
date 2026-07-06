import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { HttpResponse, http } from "msw";

import { server } from "@/test/msw/server";
import { clearToken, setToken } from "@/auth/tokenStore";

import { apiClient, onUnauthorized } from "./client";

describe("apiClient", () => {
  beforeEach(() => {
    clearToken();
    onUnauthorized(null);
  });

  afterEach(() => {
    clearToken();
    onUnauthorized(null);
  });

  it("omits X-API-Token when no token is stored", async () => {
    let receivedHeader: string | null = null;
    server.use(
      http.get("/api/v1/health-check", ({ request }) => {
        receivedHeader = request.headers.get("X-API-Token");
        return HttpResponse.json({ ok: true });
      }),
    );

    await apiClient.get("/health-check");

    expect(receivedHeader).toBeNull();
  });

  it("attaches X-API-Token when a token is stored", async () => {
    setToken("secret-token");
    let receivedHeader: string | null = null;
    server.use(
      http.get("/api/v1/health-check", ({ request }) => {
        receivedHeader = request.headers.get("X-API-Token");
        return HttpResponse.json({ ok: true });
      }),
    );

    await apiClient.get("/health-check");

    expect(receivedHeader).toBe("secret-token");
  });

  it("invokes the unauthorized listener and rejects with status 401", async () => {
    const listener = vi.fn();
    onUnauthorized(listener);
    server.use(
      http.get("/api/v1/health-check", () =>
        HttpResponse.json({ detail: "Not authenticated" }, { status: 401 }),
      ),
    );

    await expect(apiClient.get("/health-check")).rejects.toMatchObject({ status: 401 });
    expect(listener).toHaveBeenCalledOnce();
  });

  it("rejects with a structured ApiError on other failures, without touching the listener", async () => {
    const listener = vi.fn();
    onUnauthorized(listener);
    server.use(
      http.get("/api/v1/health-check", () => HttpResponse.json({ detail: "boom" }, { status: 500 })),
    );

    await expect(apiClient.get("/health-check")).rejects.toMatchObject({
      status: 500,
      detail: "boom",
    });
    expect(listener).not.toHaveBeenCalled();
  });
});