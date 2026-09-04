import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { HttpResponse, http } from "msw";

import { server } from "@/test/msw/server";
import { clearToken, setToken } from "@/auth/tokenStore";

import { apiClient, onUnauthorized, triggerUnauthorized } from "./client";

describe("apiClient", () => {
  beforeEach(() => {
    clearToken();
    onUnauthorized(null);
  });

  afterEach(() => {
    clearToken();
    onUnauthorized(null);
  });

  it("omits Authorization when no token is stored", async () => {
    let receivedHeader: string | null = null;
    server.use(
      http.get("/api/v1/health-check", ({ request }) => {
        receivedHeader = request.headers.get("Authorization");
        return HttpResponse.json({ ok: true });
      }),
    );

    await apiClient.get("/health-check");

    expect(receivedHeader).toBeNull();
  });

  it("attaches Authorization: Bearer <token> when a token is stored", async () => {
    setToken("secret-token");
    let receivedHeader: string | null = null;
    server.use(
      http.get("/api/v1/health-check", ({ request }) => {
        receivedHeader = request.headers.get("Authorization");
        return HttpResponse.json({ ok: true });
      }),
    );

    await apiClient.get("/health-check");

    expect(receivedHeader).toBe("Bearer secret-token");
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

describe("triggerUnauthorized", () => {
  afterEach(() => {
    onUnauthorized(null);
  });

  it("invokes the registered listener directly, without a request", () => {
    const listener = vi.fn();
    onUnauthorized(listener);

    triggerUnauthorized();

    expect(listener).toHaveBeenCalledOnce();
  });

  it("is a no-op when no listener is registered", () => {
    expect(() => triggerUnauthorized()).not.toThrow();
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
    let receivedContentType: string | null = null;
    let receivedValue: string | null = null;
    server.use(
      http.post("/api/v1/upload-check", async ({ request }) => {
        receivedContentType = request.headers.get("Content-Type");
        const body = await request.formData();
        receivedValue = body.get("file") as string | null;
        return HttpResponse.json({ ok: true });
      }),
    );

    const formData = new FormData();
    formData.append("file", "not-really-a-file");

    await apiClient.postForm("/upload-check", formData);

    // The browser/undici sets its own multipart boundary - the client must
    // never override it with application/json.
    expect(receivedContentType).toMatch(/^multipart\/form-data/);
    expect(receivedValue).toBe("not-really-a-file");
  });

  it("attaches Authorization: Bearer <token>", async () => {
    setToken("secret-token");
    let receivedHeader: string | null = null;
    server.use(
      http.post("/api/v1/upload-check", ({ request }) => {
        receivedHeader = request.headers.get("Authorization");
        return HttpResponse.json({ ok: true });
      }),
    );

    await apiClient.postForm("/upload-check", new FormData());

    expect(receivedHeader).toBe("Bearer secret-token");
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

  it("surfaces the raw response headers", async () => {
    server.use(
      http.post("/api/v1/blob-form-check", () =>
        new HttpResponse(new Uint8Array([1]).buffer, {
          headers: { "X-EOI-Unmatched": "section-4,section-10" },
        }),
      ),
    );

    const result = await apiClient.postFormBlob("/blob-form-check", new FormData());

    expect(result.headers.get("X-EOI-Unmatched")).toBe("section-4,section-10");
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