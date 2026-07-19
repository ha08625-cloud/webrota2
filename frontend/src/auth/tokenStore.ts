// Auth plan, Task 5. Renamed from "rota.apiToken" now that this holds a
// real per-user session token, not the old shared API_TOKEN shim value.
// Old shim tokens under the previous key are simply ignored - the system
// is not yet live, so there is no stored value to migrate.
const STORAGE_KEY = "rota.authToken";

export function getToken(): string | null {
  return window.localStorage.getItem(STORAGE_KEY);
}

export function setToken(token: string): void {
  window.localStorage.setItem(STORAGE_KEY, token);
}

export function clearToken(): void {
  window.localStorage.removeItem(STORAGE_KEY);
}