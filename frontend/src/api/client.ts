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

type UnauthorizedListener = () => void;

let unauthorizedListener: UnauthorizedListener | null = null;

/**
 * Registers the single listener invoked whenever any request comes back
 * 401. Intended for TokenGate to hook into; pass null to unregister.
 */
export function onUnauthorized(listener: UnauthorizedListener | null): void {
  unauthorizedListener = listener;
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const token = getToken();
  const headers = new Headers(init.headers);
  headers.set("Accept", "application/json");
  if (init.body !== undefined && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }
  if (token) {
    headers.set("X-API-Token", token);
  }

  const response = await fetch(`${API_BASE}${path}`, { ...init, headers });

  if (response.status === 401) {
    unauthorizedListener?.();
  }

  if (!response.ok) {
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

  if (response.status === 204) {
    return undefined as T;
  }

  return (await response.json()) as T;
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
};