import { useEffect, useState, type FormEvent, type ReactNode } from "react";

import { useQueryClient } from "@tanstack/react-query";

import { onUnauthorized } from "@/api/client";
import { useLogin, useMe } from "@/api/auth";

import { clearToken, getToken, setToken } from "./tokenStore";

interface LoginGateProps {
  children: ReactNode;
}

/**
 * Wraps the app (renamed from TokenGate now that this is a real login
 * screen, not a shared-token prompt - auth plan, Task 5).
 *
 * On mount:
 * - No stored token -> show the login form immediately. Deliberately does
 *   not fire any request first; there is nothing to verify.
 * - A stored token -> call GET /auth/me to check it is still valid before
 *   trusting it. Success renders children; a 401 clears the stale token
 *   and falls back to the login form. Renders nothing while this check is
 *   in flight, which is normally too brief to notice.
 *
 * Mid-session: still listens for the 401 broadcast from apiClient
 * (onUnauthorized) so an expired or revoked session drops back to the
 * login form from anywhere in the app, same as the old TokenGate did.
 *
 * On successful login: stores the token, then explicitly calls
 * queryClient.resetQueries() so any already-failed queries refetch
 * immediately. This is deliberate rather than relying on unmount/remount
 * of children to trigger a refetch - that would work today but only
 * because of how this component happens to be structured, and would
 * silently break if LoginGate were ever restructured to keep children
 * mounted underneath the form.
 */
export function LoginGate({ children }: LoginGateProps) {
  const queryClient = useQueryClient();
  const loginMutation = useLogin();

  const [checkingToken, setCheckingToken] = useState(() => getToken() !== null);
  const [showLoginForm, setShowLoginForm] = useState(() => getToken() === null);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [loginFailed, setLoginFailed] = useState(false);

  const meQuery = useMe(checkingToken);

  useEffect(() => {
    if (!checkingToken) {
      return;
    }
    if (meQuery.isSuccess) {
      setCheckingToken(false);
      setShowLoginForm(false);
    } else if (meQuery.isError) {
      clearToken();
      setCheckingToken(false);
      setShowLoginForm(true);
    }
  }, [checkingToken, meQuery.isSuccess, meQuery.isError]);

  useEffect(() => {
    onUnauthorized(() => {
      clearToken();
      setShowLoginForm(true);
    });
    return () => onUnauthorized(null);
  }, []);

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setLoginFailed(false);
    loginMutation.mutate(
      { email, password },
      {
        onSuccess: (data) => {
          setToken(data.token);
          setEmail("");
          setPassword("");
          setShowLoginForm(false);
          queryClient.resetQueries();
        },
        onError: () => {
          setLoginFailed(true);
        },
      },
    );
  }

  if (checkingToken) {
    return null;
  }

  if (!showLoginForm) {
    return <>{children}</>;
  }

  return (
    <div className="fixed inset-0 flex items-center justify-center bg-background">
      <form
        onSubmit={handleSubmit}
        className="w-full max-w-sm rounded border border-border bg-surface p-6 shadow-sm"
      >
        <h1 className="text-lg font-semibold text-ink">Log in</h1>
        <p className="mt-1 text-sm text-ink/70">Enter your email and password to continue.</p>

        <label className="mt-4 block text-sm text-ink" htmlFor="login-email">
          Email
        </label>
        <input
          id="login-email"
          type="email"
          autoFocus
          autoComplete="username"
          value={email}
          onChange={(event) => setEmail(event.target.value)}
          className="mt-1 w-full rounded border border-border px-3 py-2 text-sm text-ink focus:outline-none focus:ring-2 focus:ring-accent"
        />

        <label className="mt-4 block text-sm text-ink" htmlFor="login-password">
          Password
        </label>
        <input
          id="login-password"
          type="password"
          autoComplete="current-password"
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          className="mt-1 w-full rounded border border-border px-3 py-2 text-sm text-ink focus:outline-none focus:ring-2 focus:ring-accent"
        />

        {loginFailed && (
          <p className="mt-3 text-sm text-red-600" role="alert">
            Invalid email or password.
          </p>
        )}

        <button
          type="submit"
          disabled={loginMutation.isPending}
          className="mt-4 w-full rounded bg-accent px-3 py-2 text-sm font-medium text-white disabled:opacity-60"
        >
          {loginMutation.isPending ? "Logging in..." : "Log in"}
        </button>
      </form>
    </div>
  );
}