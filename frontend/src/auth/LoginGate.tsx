import { useEffect, useState, type FormEvent, type ReactNode } from "react";

import { useQueryClient } from "@tanstack/react-query";

import { onUnauthorized } from "@/api/client";
import { useForgotPassword, useLogin, useMe, useResetPassword } from "@/api/auth";
import type { ApiError, AuthUser } from "@/api/types";
import { passwordRule } from "@/lib/userSchema";

import { AuthProvider } from "./AuthContext";
import { clearToken, getToken, setToken } from "./tokenStore";

interface LoginGateProps {
  children: ReactNode;
}

/** Which of the three unauthenticated views is on screen. */
type AuthView = "login" | "forgot" | "reset";

/**
 * The emailed link's path. Built by the backend from APP_BASE_URL
 * (routers/auth.py `_reset_url`); a cold GET of it in production is
 * served index.html by SPAStaticFiles' non-/api fallback, which is what
 * makes the deep link work at all.
 */
const RESET_PATH_PREFIX = "/reset-password/";

/**
 * Identical whether or not the address exists, mirroring the backend's
 * always-204: a message that said "no account found" would hand an
 * unauthenticated caller the enumeration oracle the endpoint is built to
 * deny. It is also shown when the request itself fails, for the same
 * reason - see ForgotPasswordForm.
 */
const FORGOT_SENT_MESSAGE =
  "If that address is registered, we have emailed a link for setting a new password. " +
  "The link expires in one hour. If nothing arrives, check the address you entered is " +
  "the one you log in with, then ask a user administrator to reset it for you.";

const RESET_DONE_MESSAGE = "Your password has been reset. Please log in with your new password.";

/**
 * Reads the reset token out of the current URL, or null if this is not a
 * reset link. Only ever consulted on mount.
 */
function readResetToken(): string | null {
  const { pathname } = window.location;
  if (!pathname.startsWith(RESET_PATH_PREFIX)) {
    return null;
  }
  const raw = pathname.slice(RESET_PATH_PREFIX.length).replace(/\/+$/, "");
  return raw ? decodeURIComponent(raw) : null;
}

/**
 * Wraps the app (renamed from TokenGate now that this is a real login
 * screen, not a shared-token prompt - auth plan, Task 5).
 *
 * On mount:
 * - A /reset-password/<token> pathname -> show the reset view, whatever
 *   else is true. See "the reset view wins" below.
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
 *
 * It also owns the app-wide AuthProvider (role-based auth, Task 3): it
 * already has the current user from /auth/me or the login response, so
 * nothing else has to re-fetch it to find out what the user may do. The
 * user is held in state rather than read straight off meQuery.data
 * because that query is only ever enabled during the stored-token check -
 * after a fresh login there is no /auth/me result to read.
 *
 * WHY THE RESET PAGE IS A VIEW HERE AND NOT A ROUTE (password reset,
 * Task 4). main.tsx renders QueryClientProvider > LoginGate > App, and
 * BrowserRouter lives inside App. LoginGate renders the login form
 * *instead of* its children when there is no valid token, so a
 * <Route path="reset-password/:token"> in App would never render for the
 * logged-out user it exists for - they would get the login form at that
 * URL. Moving the gate below the router would be the cleaner long-term
 * answer, but it touches the auth boundary every page depends on for one
 * page's benefit. So the gate owns all three views itself.
 *
 * THE RESET VIEW WINS OVER A STORED TOKEN. Sessions last 30 days, so the
 * common case is a user who is *still logged in in this browser* and has
 * forgotten the password they need somewhere else. If the stored-token
 * check ran first they would be dropped straight into the app and never
 * see the reset form. A reset pathname therefore skips /auth/me entirely
 * and clears the stored token - the reset is about to delete every
 * session anyway.
 */
export function LoginGate({ children }: LoginGateProps) {
  const queryClient = useQueryClient();
  const loginMutation = useLogin();

  const [resetToken] = useState(readResetToken);
  const [view, setView] = useState<AuthView>(() => (resetToken !== null ? "reset" : "login"));
  const [checkingToken, setCheckingToken] = useState(
    () => resetToken === null && getToken() !== null,
  );
  const [showLoginForm, setShowLoginForm] = useState(
    () => resetToken !== null || getToken() === null,
  );
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [loginFailed, setLoginFailed] = useState(false);
  const [user, setUser] = useState<AuthUser | null>(null);
  const [signedOutReason, setSignedOutReason] = useState<string | null>(null);

  const meQuery = useMe(checkingToken);

  useEffect(() => {
    if (resetToken !== null) {
      clearToken();
    }
  }, [resetToken]);

  useEffect(() => {
    if (!checkingToken) {
      return;
    }
    if (meQuery.isSuccess) {
      setUser(meQuery.data);
      setCheckingToken(false);
      setShowLoginForm(false);
    } else if (meQuery.isError) {
      clearToken();
      setCheckingToken(false);
      setShowLoginForm(true);
    }
  }, [checkingToken, meQuery.isSuccess, meQuery.isError, meQuery.data]);

  useEffect(() => {
    onUnauthorized((reason) => {
      clearToken();
      setUser(null);
      setSignedOutReason(reason ?? null);
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
          setUser(data.user);
          setSignedOutReason(null);
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

  /**
   * Back to the login form after a successful reset, with the URL tidied
   * so a refresh does not re-submit a token that no longer exists. The
   * existing signedOutReason state already means "you are back here on
   * purpose", which is exactly this case.
   */
  function handleResetComplete() {
    window.history.replaceState(null, "", "/");
    setSignedOutReason(RESET_DONE_MESSAGE);
    setView("login");
  }

  if (checkingToken) {
    return null;
  }

  if (!showLoginForm) {
    return <AuthProvider user={user}>{children}</AuthProvider>;
  }

  if (view === "reset" && resetToken !== null) {
    return <ResetPasswordForm token={resetToken} onComplete={handleResetComplete} />;
  }

  if (view === "forgot") {
    return <ForgotPasswordForm onBack={() => setView("login")} />;
  }

  return (
    <AuthCard onSubmit={handleSubmit}>
      <h1 className="text-lg font-semibold text-ink">Log in</h1>
      <p className="mt-1 text-sm text-ink/70">Enter your email and password to continue.</p>

      {/* Why the user is back here, when it was the expected result of
          something they just did - a password change or a completed
          reset signs out every session including this one. A plain
          expired session passes no reason and shows nothing extra. */}
      {signedOutReason ? (
        <p className="mt-3 rounded bg-accent/10 p-2 text-sm text-ink" role="status">
          {signedOutReason}
        </p>
      ) : null}

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

      <button
        type="button"
        onClick={() => {
          setLoginFailed(false);
          setSignedOutReason(null);
          setView("forgot");
        }}
        className="mt-3 block w-full text-center text-sm text-accent hover:underline"
      >
        Forgot password?
      </button>
    </AuthCard>
  );
}

/** The one card shell all three views sit in. */
function AuthCard({
  children,
  onSubmit,
}: {
  children: ReactNode;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
}) {
  return (
    <div className="fixed inset-0 flex items-center justify-center bg-background">
      <form
        onSubmit={onSubmit}
        className="w-full max-w-sm rounded border border-border bg-surface p-6 shadow-sm"
      >
        {children}
      </form>
    </div>
  );
}

/**
 * Request a reset link. The confirmation is the same whatever the backend
 * did - and, deliberately, the same whether the request succeeded or
 * failed: the endpoint answers 204 for an unknown address, an inactive
 * user, a throttled request and a Mailgun failure alike, so anything the
 * UI added here (a "no account with that address", or an error banner on
 * a path the backend never distinguishes) would only re-open the
 * enumeration hole the 204 exists to close. The cost is that a genuine
 * server error looks like success; the copy therefore names the fallback
 * - ask a user administrator - rather than promising an email.
 *
 * The address is matched exactly and case-sensitively by the backend, the
 * way login matches it, so the copy has to tell the user to enter the
 * address they log in with. Do not soften that into something friendlier:
 * a typo here is indistinguishable from success, and this sentence is the
 * only thing standing between the user and a silent dead end.
 */
function ForgotPasswordForm({ onBack }: { onBack: () => void }) {
  const forgotPassword = useForgotPassword();
  const [email, setEmail] = useState("");
  const [sent, setSent] = useState(false);

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    forgotPassword.mutate({ email }, { onSettled: () => setSent(true) });
  }

  return (
    <AuthCard onSubmit={handleSubmit}>
      <h1 className="text-lg font-semibold text-ink">Reset your password</h1>
      <p className="mt-1 text-sm text-ink/70">
        Enter the email address you log in with and we will email you a link for setting a new
        password.
      </p>

      {sent ? (
        <p className="mt-3 rounded bg-accent/10 p-2 text-sm text-ink" role="status">
          {FORGOT_SENT_MESSAGE}
        </p>
      ) : null}

      <label className="mt-4 block text-sm text-ink" htmlFor="forgot-email">
        Email
      </label>
      <input
        id="forgot-email"
        type="email"
        autoFocus
        autoComplete="username"
        value={email}
        onChange={(event) => setEmail(event.target.value)}
        className="mt-1 w-full rounded border border-border px-3 py-2 text-sm text-ink focus:outline-none focus:ring-2 focus:ring-accent"
      />

      <button
        type="submit"
        disabled={forgotPassword.isPending}
        className="mt-4 w-full rounded bg-accent px-3 py-2 text-sm font-medium text-white disabled:opacity-60"
      >
        {forgotPassword.isPending ? "Sending..." : "Email me a link"}
      </button>

      <button
        type="button"
        onClick={onBack}
        className="mt-3 block w-full text-center text-sm text-accent hover:underline"
      >
        Back to log in
      </button>
    </AuthCard>
  );
}

/**
 * Set a new password from an emailed token. A 400 - unknown, expired,
 * already redeemed, or issued to a user since deactivated - renders the
 * backend's single message in place and stays put; it must never drop the
 * user to the login form, which is exactly what a 401 here would do via
 * apiClient's global onUnauthorized listener.
 */
function ResetPasswordForm({ token, onComplete }: { token: string; onComplete: () => void }) {
  const resetPassword = useResetPassword();
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);

    // Same rule as ChangePasswordDialog and the Users form, so an 8-char
    // minimum is not first learned from a 422.
    const parsed = passwordRule.safeParse(password);
    if (!parsed.success) {
      setError(parsed.error.issues[0].message);
      return;
    }
    if (password !== confirm) {
      setError("The two passwords do not match.");
      return;
    }

    resetPassword.mutate(
      { token, password },
      {
        onSuccess: onComplete,
        onError: (err: ApiError) => {
          setError(
            typeof err.detail === "string"
              ? err.detail
              : "Could not reset your password. Please request a new link.",
          );
        },
      },
    );
  }

  return (
    <AuthCard onSubmit={handleSubmit}>
      <h1 className="text-lg font-semibold text-ink">Set a new password</h1>
      <p className="mt-1 text-sm text-ink/70">
        This will sign you out on every device, then you can log in again with the new password.
      </p>

      {error ? (
        <p className="mt-3 rounded bg-red-50 p-2 text-sm text-red-700" role="alert">
          {error}
        </p>
      ) : null}

      <label className="mt-4 block text-sm text-ink" htmlFor="reset-password">
        New password
      </label>
      <input
        id="reset-password"
        type="password"
        autoFocus
        autoComplete="new-password"
        value={password}
        onChange={(event) => setPassword(event.target.value)}
        className="mt-1 w-full rounded border border-border px-3 py-2 text-sm text-ink focus:outline-none focus:ring-2 focus:ring-accent"
      />

      <label className="mt-4 block text-sm text-ink" htmlFor="reset-password-confirm">
        Confirm new password
      </label>
      <input
        id="reset-password-confirm"
        type="password"
        autoComplete="new-password"
        value={confirm}
        onChange={(event) => setConfirm(event.target.value)}
        className="mt-1 w-full rounded border border-border px-3 py-2 text-sm text-ink focus:outline-none focus:ring-2 focus:ring-accent"
      />

      <button
        type="submit"
        disabled={resetPassword.isPending}
        className="mt-4 w-full rounded bg-accent px-3 py-2 text-sm font-medium text-white disabled:opacity-60"
      >
        {resetPassword.isPending ? "Saving..." : "Set new password"}
      </button>
    </AuthCard>
  );
}
