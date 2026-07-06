import { useEffect, useState, type FormEvent, type ReactNode } from "react";

import { useQueryClient } from "@tanstack/react-query";

import { onUnauthorized } from "@/api/client";

import { setToken } from "./tokenStore";

interface TokenGateProps {
  children: ReactNode;
}

/**
 * Wraps the app. Normally renders children untouched. When any request
 * comes back 401 (registered via onUnauthorized), switches to a full-screen
 * token prompt instead of rendering children at all - the goal is that a
 * missing/wrong token is impossible to miss, not a toast buried behind
 * broken content.
 *
 * On submit: stores the token, then explicitly calls
 * queryClient.resetQueries() so already-failed queries refetch immediately.
 * This is deliberate rather than relying on unmount/remount of children to
 * trigger a refetch - that would work today but only because of how this
 * component happens to be structured, and would silently break if TokenGate
 * were ever restructured to keep children mounted underneath the prompt.
 */
export function TokenGate({ children }: TokenGateProps) {
  const [unauthorized, setUnauthorized] = useState(false);
  const [inputValue, setInputValue] = useState("");
  const queryClient = useQueryClient();

  useEffect(() => {
    onUnauthorized(() => setUnauthorized(true));
    return () => onUnauthorized(null);
  }, []);

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const trimmed = inputValue.trim();
    if (!trimmed) {
      return;
    }
    setToken(trimmed);
    setInputValue("");
    setUnauthorized(false);
    queryClient.resetQueries();
  }

  if (!unauthorized) {
    return <>{children}</>;
  }

  return (
    <div className="fixed inset-0 flex items-center justify-center bg-background">
      <form
        onSubmit={handleSubmit}
        className="w-full max-w-sm rounded border border-border bg-surface p-6 shadow-sm"
      >
        <h1 className="text-lg font-semibold text-ink">Enter access token</h1>
        <p className="mt-1 text-sm text-ink/70">
          The server rejected the last request as unauthorized. Enter the shared API token to
          continue.
        </p>
        <input
          type="password"
          autoFocus
          value={inputValue}
          onChange={(event) => setInputValue(event.target.value)}
          placeholder="API token"
          className="mt-4 w-full rounded border border-border px-3 py-2 text-sm text-ink focus:outline-none focus:ring-2 focus:ring-accent"
        />
        <button
          type="submit"
          className="mt-4 w-full rounded bg-accent px-3 py-2 text-sm font-medium text-white"
        >
          Continue
        </button>
      </form>
    </div>
  );
}