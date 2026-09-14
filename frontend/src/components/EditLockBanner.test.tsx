import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { HttpResponse, http } from "msw";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { EditLock } from "@/api/locks";
import type { Permissions } from "@/api/types";
import { AuthProvider, EditLockProvider } from "@/auth/AuthContext";
import { clearToken, setToken } from "@/auth/tokenStore";
import { PERMISSION_PRESETS, makeAuthUser } from "@/test/fixtures/reference";
import { server } from "@/test/msw/server";

import { EditLockBanner, EditLockDialog, formatStartedAgo } from "./EditLockBanner";

const ME = 1;
const SOMEONE_ELSE = 2;

/**
 * Rendered inside a real EditLockProvider rather than a stubbed context,
 * so these cover what the user actually meets: the provider's reading of
 * GET /locks and of a 409 acquire. The context is not exported for
 * stubbing, deliberately - see AuthContext.tsx.
 */
function renderBanner({
  locks = [],
  permissions = PERMISSION_PRESETS.manager,
}: { locks?: EditLock[]; permissions?: Permissions } = {}) {
  server.use(http.get("/api/v1/locks", () => HttpResponse.json(locks)));

  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <AuthProvider user={makeAuthUser({ id: ME, name: "Ann", permissions })}>
        <EditLockProvider area="clinical">
          <EditLockBanner />
          <EditLockDialog />
        </EditLockProvider>
      </AuthProvider>
    </QueryClientProvider>,
  );
}

function makeLock(overrides: Partial<EditLock> = {}): EditLock {
  return {
    area: "clinical",
    user_id: SOMEONE_ELSE,
    user_name: "Kristel",
    acquired_at: new Date(Date.now() - 20 * 60_000).toISOString(),
    last_activity_at: new Date().toISOString(),
    idle: false,
    ...overrides,
  };
}

const HELD_409 = {
  detail: {
    message: "Kristel is editing the clinical rota",
    code: "edit_lock_held",
    area: "clinical",
    holder_user_id: SOMEONE_ELSE,
    holder_name: "Kristel",
    acquired_at: new Date(Date.now() - 20 * 60_000).toISOString(),
    last_activity_at: new Date().toISOString(),
  },
};

/** The strip's text with JSX's line breaks collapsed, so assertions read as prose. */
function bannerText(): string {
  return screen.getByRole("status").textContent?.replace(/\s+/g, " ").trim() ?? "";
}

beforeEach(() => {
  // The acquire and the release both need a token to look logged in.
  setToken("test-token");
});

afterEach(() => {
  clearToken();
});

describe("formatStartedAgo", () => {
  const NOW = new Date("2026-01-01T12:00:00Z").getTime();

  function ago(minutes: number): string {
    return formatStartedAgo(new Date(NOW - minutes * 60_000).toISOString(), NOW);
  }

  it("says 'just now' under a minute, rather than '0 minutes ago'", () => {
    expect(ago(0)).toBe("just now");
  });

  it("counts whole minutes, singular and plural", () => {
    expect(ago(1)).toBe("1 minute ago");
    expect(ago(20)).toBe("20 minutes ago");
    expect(ago(59)).toBe("59 minutes ago");
  });

  it("switches to hours past the hour", () => {
    expect(ago(60)).toBe("1 hour ago");
    expect(ago(150)).toBe("2 hours ago");
  });

  it("falls back to the timestamp past a day, where an elapsed count stops helping", () => {
    // Locale-formatted, so the assertion is on what it is NOT: an
    // ever-growing hour count.
    expect(ago(48 * 60)).not.toMatch(/ago/);
  });
});

describe("EditLockBanner", () => {
  it("renders nothing at all when no lock exists", async () => {
    renderBanner();

    // Nothing to wait for on the empty path, so prove the poll has landed
    // (the acquire's own response invalidates it) and then assert silence.
    await waitFor(() => expect(screen.queryByRole("status")).not.toBeInTheDocument());
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  it("names the holder and how long ago they started", async () => {
    renderBanner({ locks: [makeLock()] });

    await waitFor(() => expect(bannerText()).toContain("Kristel"));
    expect(bannerText()).toContain("started 20 minutes ago");
    expect(bannerText()).toMatch(/read it, but not make changes/);
  });

  it("confirms quietly when the lock is mine, so I know why others cannot edit", async () => {
    renderBanner({ locks: [makeLock({ user_id: ME, user_name: "Ann" })] });

    await waitFor(() => expect(bannerText()).toMatch(/^You are editing this section/));
    expect(bannerText()).toContain("Others can read it");
    // Not the other-holder wording, which would be the banner naming me as
    // somebody in my own way.
    expect(bannerText()).not.toContain("until they leave");
  });

  it("stays silent on an idle lock, which this user's next write would take", async () => {
    renderBanner({ locks: [makeLock({ idle: true })] });

    // The section is writable (useCanWrite ignores an idle lock), so a
    // banner saying Kristel is editing would contradict the live controls.
    await waitFor(() => expect(screen.queryByRole("status")).not.toBeInTheDocument());
  });

  it("tells a read-only login who is in the section", async () => {
    renderBanner({ locks: [makeLock()], permissions: PERMISSION_PRESETS.readOnly });

    // They could never edit here anyway, but "Kristel is in the rota" is
    // still the answer to "why has nothing changed since this morning".
    await waitFor(() => expect(bannerText()).toContain("Kristel"));
  });
});

describe("EditLockDialog", () => {
  it("explains, once, why a section entered second is read-only", async () => {
    server.use(http.post("/api/v1/locks/:area", () => HttpResponse.json(HELD_409, { status: 409 })));

    renderBanner({ locks: [makeLock()] });

    const dialog = await screen.findByRole("dialog");
    expect(dialog).toHaveTextContent("Someone else is editing this section");
    // The server's own sentence, not a rewrite of it.
    expect(dialog).toHaveTextContent("Kristel is editing the clinical rota");
    expect(dialog).toHaveTextContent("They started 20 minutes ago");
    // The 15-minute rule is the only route back in, so it is the only
    // useful thing to tell somebody who needs to edit.
    expect(dialog).toHaveTextContent(/15 minutes after their last change/);
  });

  it("offers no way to take editing control, because there is none", async () => {
    server.use(http.post("/api/v1/locks/:area", () => HttpResponse.json(HELD_409, { status: 409 })));

    renderBanner({ locks: [makeLock()] });

    const dialog = await screen.findByRole("dialog");
    expect(dialog).toHaveTextContent("no way to take editing control");
    const buttons = await screen.findAllByRole("button");
    expect(buttons.map((button) => button.textContent)).toEqual(["Continue reading"]);
  });

  it("closes on dismissal and does not come back", async () => {
    server.use(http.post("/api/v1/locks/:area", () => HttpResponse.json(HELD_409, { status: 409 })));

    renderBanner({ locks: [makeLock()] });

    await screen.findByRole("dialog");
    await userEvent.click(screen.getByRole("button", { name: "Continue reading" }));

    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    // The banner is what remains, which is the whole point of having one.
    expect(bannerText()).toContain("Kristel");
  });

  it("says nothing when the lock was free and the acquire succeeded", async () => {
    server.use(
      http.post("/api/v1/locks/:area", () =>
        HttpResponse.json(makeLock({ user_id: ME, user_name: "Ann" })),
      ),
    );

    renderBanner({ locks: [makeLock({ user_id: ME, user_name: "Ann" })] });

    await waitFor(() => expect(bannerText()).toMatch(/^You are editing/));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });
});
