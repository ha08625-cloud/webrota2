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

describe("apiClient.postForm", () => {
  beforeEach(() => {
    clearToken();
    onUnauthorized(null);
  });

  afterEach(() => {
    clearToken();
    onUnauthorized(null);
  });

  it("sends no explicit JSON Content-Type and passes the FormData through", async () => {
    // Deliberately reads raw headers/text here rather than calling
    // request.formData() server-side: under Vitest's jsdom environment,
    // `new FormData()` in this file resolves to jsdom's FormData class,
    // not the one Node's undici (which MSW's node interceptor also uses)
    // checks for internally via `instanceof`. That mismatch is a test
    // -environment artifact, not a client bug - a real browser has only
    // one FormData class - but it means undici's own request.formData()
    // parser throws here regardless of what the client actually sent.
    // Checking the boundary is present and the field value made it into
    // the raw body proves the same thing without hitting that parser.
    let receivedContentType: string | null = null;
    let receivedBody = "";
    server.use(
      http.post("/api/v1/upload-check", async ({ request }) => {
        receivedContentType = request.headers.get("Content-Type");
        receivedBody = await request.text();
        return HttpResponse.json({ ok: true });
      }),
    );

    const formData = new FormData();
    formData.append("file", "not-really-a-file");

    await apiClient.postForm("/upload-check", formData);

    // The browser/undici sets its own multipart boundary - the client must
    // never override it with application/json.
    expect(receivedContentType).toMatch(/^multipart\/form-data/);
    expect(receivedContentType).toContain("boundary=");
    expect(receivedBody).toContain("not-really-a-file");
  });

  it("attaches X-API-Token", async () => {
    setToken("secret-token");
    let receivedHeader: string | null = null;
    server.use(
      http.post("/api/v1/upload-check", ({ request }) => {
        receivedHeader = request.headers.get("X-API-Token");
        return HttpResponse.json({ ok: true });
      }),
    );

    await apiClient.postForm("/upload-check", new FormData());

    expect(receivedHeader).toBe("secret-token");
  });

  it("fires the unauthorized listener on 401", async () => {
    const listener = vi.fn();
    onUnauthorized(listener);
    server.use(
      http.post("/api/v1/upload-check", () =>
        HttpResponse.json({ detail: "Not authenticated" }, { status: 401 }),
      ),
    );

    await expect(apiClient.postForm("/upload-check", new FormData())).rejects.toMatchObject({
      status: 401,
    });
    expect(listener).toHaveBeenCalledOnce();
  });
});

describe("apiClient.getBlob", () => {
  beforeEach(() => {
    clearToken();
    onUnauthorized(null);
  });

  afterEach(() => {
    clearToken();
    onUnauthorized(null);
  });

  it("resolves a Blob on success", async () => {
    server.use(
      http.get("/api/v1/blob-check", () =>
        new HttpResponse(new Uint8Array([1, 2, 3]).buffer, {
          headers: { "Content-Type": "image/png" },
        }),
      ),
    );

    const blob = await apiClient.getBlob("/blob-check");

    expect(blob).toBeInstanceOf(Blob);
    expect(blob.type).toBe("image/png");
    expect(blob.size).toBe(3);
  });

  it("throws a structured ApiError on a 500 with a JSON body", async () => {
    server.use(
      http.get("/api/v1/blob-check", () => HttpResponse.json({ detail: "boom" }, { status: 500 })),
    );

    await expect(apiClient.getBlob("/blob-check")).rejects.toMatchObject({
      status: 500,
      detail: "boom",
    });
  });

  it("fires the unauthorized listener on 401", async () => {
    const listener = vi.fn();
    onUnauthorized(listener);
    server.use(
      http.get("/api/v1/blob-check", () =>
        HttpResponse.json({ detail: "Not authenticated" }, { status: 401 }),
      ),
    );

    await expect(apiClient.getBlob("/blob-check")).rejects.toMatchObject({ status: 401 });
    expect(listener).toHaveBeenCalledOnce();
  });
});

describe("apiClient.postFormBlob", () => {
  beforeEach(() => {
    clearToken();
    onUnauthorized(null);
  });

  afterEach(() => {
    clearToken();
    onUnauthorized(null);
  });

  it("extracts the filename from Content-Disposition", async () => {
    server.use(
      http.post("/api/v1/blob-form-check", () =>
        new HttpResponse(new Uint8Array([1, 2, 3]).buffer, {
          headers: {
            "Content-Type": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
            "Content-Disposition": 'attachment; filename="letter-signed.docx"',
          },
        }),
      ),
    );

    const result = await apiClient.postFormBlob("/blob-form-check", new FormData());

    expect(result.blob).toBeInstanceOf(Blob);
    expect(result.filename).toBe("letter-signed.docx");
  });

  it("returns a null filename when Content-Disposition is missing", async () => {
    server.use(
      http.post("/api/v1/blob-form-check", () => new HttpResponse(new Uint8Array([1]).buffer)),
    );

    const result = await apiClient.postFormBlob("/blob-form-check", new FormData());

    expect(result.filename).toBeNull();
  });

  it("fires the unauthorized listener on 401", async () => {
    const listener = vi.fn();
    onUnauthorized(listener);
    server.use(
      http.post("/api/v1/blob-form-check", () =>
        HttpResponse.json({ detail: "Not authenticated" }, { status: 401 }),
      ),
    );

    await expect(apiClient.postFormBlob("/blob-form-check", new FormData())).rejects.toMatchObject({
      status: 401,
    });
    expect(listener).toHaveBeenCalledOnce();
  });
});
