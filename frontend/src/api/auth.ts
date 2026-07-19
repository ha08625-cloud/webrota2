import { useMutation, useQuery } from "@tanstack/react-query";

import { apiClient } from "./client";
import type { AuthUser, LoginIn, LoginOut } from "./types";

export const authKeys = {
  me: ["auth", "me"] as const,
};

/** POST /auth/login - stores nothing itself; the caller (LoginGate) is responsible for setToken(). */
export function useLogin() {
  return useMutation({
    mutationFn: (body: LoginIn) => apiClient.post<LoginOut>("/auth/login", body),
  });
}

/** POST /auth/logout - 204 on success. Session-deletion failures are the caller's problem to ignore, not this hook's. */
export function useLogout() {
  return useMutation({
    mutationFn: () => apiClient.post<void>("/auth/logout"),
  });
}

/**
 * GET /auth/me - used by LoginGate to verify a stored token is still
 * valid before trusting it and rendering the app. `enabled` is passed in
 * explicitly rather than defaulted to true: LoginGate must not fire this
 * at all when there is no stored token (auth plan, Task 5 - "no token ->
 * login form immediately, do not wait for a request to fail"). `retry:
 * false` because a 401 here is an expected, meaningful result (token
 * expired/revoked), not a transient failure worth retrying - the global
 * queryClient default in main.tsx already skips retries on 4xx, this is
 * just explicit about why.
 */
export function useMe(enabled: boolean) {
  return useQuery({
    queryKey: authKeys.me,
    queryFn: () => apiClient.get<AuthUser>("/auth/me"),
    enabled,
    retry: false,
  });
}