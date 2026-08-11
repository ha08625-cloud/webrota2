import { getToken } from "@/auth/tokenStore";

import type { ApiError } from "./types";

/**
 * Relative by default so the same client code works in both dev (via the
 * Vite proxy in vite.config.ts, against a local backend) and production
 * (FastAPI serving the built SPA same-origin, per the M3.5 static mount).
 * Set VITE_API_BASE_URL to develop against the deployed Railway backend
 * instead - see .env.example.
 */
const API_BASE = import.meta.env.VITE_API_BASE_URL ?? "/api/v1";

/**
 * `reason` is an optional message to show on the login form explaining
 * why the user landed back there. A real 401 passes nothing (the session
 * simply expired); the deliberate callers below pass one when the sign-out
 * was an expected consequence of something the user just did - notably a
 * successful password change, which deletes every session including the
 * current one (role-based auth, Task 3 instruction 6).
 */
type UnauthorizedListener = (reason?: string) => void;

let unauthorizedListener: UnauthorizedListener | null = null;

/**
 * Registers the single listener invoked whenever any request comes back
 * 401. Intended for LoginGate to hook into; pass null to unregister.
 */
export function onUnauthorized(listener: UnauthorizedListener | null): void {
  unauthorizedListener = listener;
}

/**
 * Fires the same listener a real 401 would, without a request having
 * failed. Used by the logout flow (App.tsx) to drop back to the login
 * form immediately after clearing the token - logout is a 204, not a
 * 401, so it can't rely on the normal rawFetch path below to trigger it -
 * and by the password-change flow, which passes a reason.
 */
export function triggerUnauthorized(reason?: string): void {
  unauthorizedListener?.(reason);
}

/**
 * Shared plumbing for every request shape below: attaches the auth
 * header, fires the 401 listener, and returns the raw Response - callers
 * decide how to turn that into JSON, a Blob, or nothing at all.
 *
 * Headers are passed as a plain Record, never wrapped in `new Headers()`.
 * That wrapping was tried first and caused a real bug: for a FormData
 * body, the browser/runtime is supposed to compute
 * `Content-Type: multipart/form-data; boundary=...` itself, but
 * pre-constructing a Headers instance before the fetch call - even one
 * with no Content-Type key set - lost that computed boundary under
 * jsdom + MSW, and the server-side `request.formData()` then rejected
 * the body outright ("Content-Type was not one of multipart/form-data or
 * application/x-www-form-urlencoded"). A plain object passed straight
 * through to fetch()'s `headers` option does not have this problem.
 */
async function rawFetch(path: string, init: RequestInit): Promise<Response> {
  const token = getToken();
  const headers: Record<string, string> = { ...(init.headers as Record<string, string> | undefined) };
  if (token) {
    headers["Authorization"] = `Bearer ${token}`;
  }

  const response = await fetch(`${API_BASE}${path}`, { ...init, headers });

  if (response.status === 401) {
    unauthorizedListener?.();
  }

  return response;
}

/**
 * Throws a structured ApiError for any non-2xx response. Error bodies are
 * still JSON even on the binary endpoints (FastAPI's HTTPException
 * responses), so this is shared unchanged across every transport.
 */
async function throwIfError(response: Response): Promise<void> {
  if (response.ok) {
    return;
  }
  let detail: unknown = response.statusText;
  try {
    const body = await response.json();
    detail = typeof body === "object" && body !== null && "detail" in body ? body.detail : body;
  } catch {
    // Body wasn't JSON (or was empty) - keep the status text as detail.
  }
  const error: ApiError = { status: response.status, detail };
  throw error;
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const callerHeaders = (init.headers as Record<string, string> | undefined) ?? {};
  const headers: Record<string, string> = { Accept: "application/json", ...callerHeaders };
  if (init.body !== undefined && !("Content-Type" in headers)) {
    headers["Content-Type"] = "application/json";
  }

  const response = await rawFetch(path, { ...init, headers });
  await throwIfError(response);

  if (response.status === 204) {
    return undefined as T;
  }

  return (await response.json()) as T;
}

/**
 * POST with a FormData body, JSON response. Deliberately sets no
 * Content-Type at all - see rawFetch's docstring for why even an
 * empty-looking Headers() wrapper is unsafe here.
 */
async function requestForm<T>(path: string, formData: FormData): Promise<T> {
  const headers: Record<string, string> = { Accept: "application/json" };

  const response = await rawFetch(path, { method: "POST", body: formData, headers });
  await throwIfError(response);

  if (response.status === 204) {
    return undefined as T;
  }

  return (await response.json()) as T;
}

/** `filename="..."` out of a Content-Disposition header; null if absent or unparsable. */
function parseFilename(response: Response): string | null {
  const header = response.headers.get("Content-Disposition");
  if (!header) {
    return null;
  }
  const match = /filename="([^"]*)"/.exec(header);
  return match ? match[1] : null;
}

export const apiClient = {
  get: <T>(path: string) => request<T>(path, { method: "GET" }),
  post: <T>(path: string, body?: unknown) =>
    request<T>(path, {
      method: "POST",
      body: body !== undefined ? JSON.stringify(body) : undefined,
    }),
  patch: <T>(path: string, body?: unknown) =>
    request<T>(path, {
      method: "PATCH",
      body: body !== undefined ? JSON.stringify(body) : undefined,
    }),
  put: <T>(path: string, body?: unknown) =>
    request<T>(path, {
      method: "PUT",
      body: body !== undefined ? JSON.stringify(body) : undefined,
    }),
  delete: <T>(path: string) => request<T>(path, { method: "DELETE" }),

  /** POST multipart/form-data, JSON response - e.g. signature image upload. */
  postForm: <T>(path: string, formData: FormData) => requestForm<T>(path, formData),

  /** GET a binary response body as a Blob - e.g. the stored signature image. */
  getBlob: async (path: string): Promise<Blob> => {
    const response = await rawFetch(path, { method: "GET" });
    await throwIfError(response);
    return response.blob();
  },

  /**
   * POST multipart/form-data, binary response - the "drop a docx, get a
   * signed docx back" apply endpoint. Returns the filename the server
   * proposed via Content-Disposition alongside the blob, so the caller can
   * trigger a same-named download.
   */
  postFormBlob: async (path: string, formData: FormData): Promise<{ blob: Blob; filename: string | null }> => {
    const response = await rawFetch(path, { method: "POST", body: formData });
    await throwIfError(response);
    const blob = await response.blob();
    return { blob, filename: parseFilename(response) };
  },
};
