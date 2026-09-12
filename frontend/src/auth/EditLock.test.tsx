import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import { HttpResponse, http } from "msw";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { EditLock } from "@/api/locks";
import type { Permissions } from "@/api/types";
import { PERMISSION_PRESETS, makeAuthUser } from "@/test/fixtures/reference";
import { server } from "@/test/msw/server";

import {
  AuthProvider,
  EditLockProvider,
  NO_WRITE_ACCESS_TITLE,
  PermissionAreaProvider,
  editLockTitle,
  useCanRead,
  useCanWrite,
  useEditLock,
  useWriteGate,
  type PermissionArea,
} from "./AuthContext";
import { clearToken, setToken } from "./tokenStore";

const ME = 1;
const SOMEONE_ELSE = 2;

function makeLock(overrides: Partial<EditLock> = {}): EditLock {
  return {
    area: "clinical",
    user_id: SOMEONE_ELSE,
    user_name: "Kristel",
    acquired_at: "2026-01-01T09:00:00Z",
    last_activity_at: "2026-01-01T09:00:00Z",
    idle: false,
    ...overrides,
  };
}

/**
 * Reports the three answers a component actually asks for, plus the
 * tooltip text, so each test can assert on the question it is about
 * rather than on some rendered control standing in for it.
 */
function Probe({ otherArea }: { otherArea?: PermissionArea }) {
  const lock = useEditLock();
  const gate = useWriteGate();
  return (
    <ul>
      <li data-testid="can-write">{String(useCanWrite())}</li>
      <li data-testid="can-read">{String(useCanRead())}</li>
      <li data-testid="can-write-elsewhere">{String(useCanWrite(otherArea ?? "reception"))}</li>
      <li data-testid="held-by-other">{String(lock.heldByOther)}</li>
      <li data-testid="holder-is-me">{String(lock.holderIsMe)}</li>
      <li data-testid="holder-name">{String(lock.holderName)}</li>
      <li data-testid="gate-title">{gate.title ?? "none"}</li>
    </ul>
  );
}

interface Options {
  permissions?: Permissions;
  locks?: EditLock[];
  area?: "clinical" | "reception";
  probeArea?: PermissionArea;
}

function renderLocked({
  permissions = PERMISSION_PRESETS.manager,
  locks = [],
  area = "clinical",
  probeArea,
}: Options = {}) {
  server.use(http.get("/api/v1/locks", () => HttpResponse.json(locks)));

  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const result = render(
    <QueryClientProvider client={queryClient}>
      <AuthProvider user={makeAuthUser({ id: ME, name: "Ann", permissions })}>
        <EditLockProvider area={area}>
          <PermissionAreaProvider area={area}>
            <Probe otherArea={probeArea} />
          </PermissionAreaProvider>
        </EditLockProvider>
      </AuthProvider>
    </QueryClientProvider>,
  );
  return { ...result, queryClient };
}

function flags() {
  return {
    canWrite: screen.getByTestId("can-write").textContent,
    canRead: screen.getByTestId("can-read").textContent,
    heldByOther: screen.getByTestId("held-by-other").textContent,
    holderIsMe: screen.getByTestId("holder-is-me").textContent,
    title: screen.getByTestId("gate-title").textContent,
  };
}

beforeEach(() => {
  // The release on unmount is skipped without a token - see
  // EditLockProvider - so the tests about releasing have to look logged in.
  setToken("test-token");
});

afterEach(() => {
  clearToken();
});

describe("EditLockProvider acquisition", () => {
  it("takes the lock on entering a section the login can write", async () => {
    const acquired: string[] = [];
    server.use(
      http.post("/api/v1/locks/:area", ({ params }) => {
        acquired.push(String(params.area));
        return HttpResponse.json(makeLock({ user_id: ME, user_name: "Ann" }));
      }),
    );

    renderLocked();

    await waitFor(() => expect(acquired).toEqual(["clinical"]));
  });

  it("never acquires for a read-only login, so a reader blocks nobody", async () => {
    let acquires = 0;
    server.use(
      http.post("/api/v1/locks/:area", () => {
        acquires += 1;
        return HttpResponse.json(makeLock({ user_id: ME }));
      }),
    );

    renderLocked({ permissions: PERMISSION_PRESETS.readOnly, locks: [makeLock()] });

    // Nothing to wait for on the happy path, so wait for the poll to land -
    // which proves the provider has mounted and done its work - and then
    // assert the acquire was never among it.
    await waitFor(() => expect(screen.getByTestId("holder-name").textContent).toBe("Kristel"));
    expect(acquires).toBe(0);
  });

  it("gives the lock back on leaving the section", async () => {
    const released: string[] = [];
    server.use(
      http.post("/api/v1/locks/:area", () => HttpResponse.json(makeLock({ user_id: ME }))),
      http.delete("/api/v1/locks/:area", ({ params }) => {
        released.push(String(params.area));
        return new HttpResponse(null, { status: 204 });
      }),
    );

    const { unmount } = renderLocked({ area: "reception" });
    await waitFor(() => expect(screen.getByTestId("can-write").textContent).toBe("true"));
    unmount();

    await waitFor(() => expect(released).toEqual(["reception"]));
  });

  it("does not release once the token has gone, which would only be a 401", async () => {
    let releases = 0;
    server.use(
      http.post("/api/v1/locks/:area", () => HttpResponse.json(makeLock({ user_id: ME }))),
      http.delete("/api/v1/locks/:area", () => {
        releases += 1;
        return new HttpResponse(null, { status: 204 });
      }),
    );

    const { unmount } = renderLocked();
    await waitFor(() => expect(screen.getByTestId("can-write").textContent).toBe("true"));
    clearToken();
    unmount();

    // The release is fired (or not) in the effect cleanup; one macrotask is
    // enough for the request to have been recorded if it happened.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(releases).toBe(0);
  });

  it("survives a 409 acquire - being second in is an outcome, not a failure", async () => {
    server.use(
      http.post("/api/v1/locks/:area", () =>
        HttpResponse.json(
          {
            detail: {
              message: "Kristel is editing the clinical rota",
              code: "edit_lock_held",
              area: "clinical",
              holder_user_id: SOMEONE_ELSE,
              holder_name: "Kristel",
              acquired_at: "2026-01-01T09:00:00Z",
              last_activity_at: "2026-01-01T09:00:00Z",
            },
          },
          { status: 409 },
        ),
      ),
    );

    renderLocked({ locks: [makeLock()] });

    await waitFor(() => expect(flags().canWrite).toBe("false"));
    expect(flags().heldByOther).toBe("true");
  });
});

describe("the lock lowers useCanWrite", () => {
  it("takes writes away while somebody else is in the section", async () => {
    renderLocked({ locks: [makeLock()] });

    await waitFor(() => expect(flags().canWrite).toBe("false"));
    expect(flags().holderIsMe).toBe("false");
  });

  it("never takes reads away - reading is not blocked, for anyone, ever", async () => {
    renderLocked({ locks: [makeLock()] });

    await waitFor(() => expect(flags().canWrite).toBe("false"));
    expect(flags().canRead).toBe("true");
  });

  it("leaves the holder writing", async () => {
    renderLocked({ locks: [makeLock({ user_id: ME, user_name: "Ann" })] });

    await waitFor(() => expect(flags().holderIsMe).toBe("true"));
    expect(flags().canWrite).toBe("true");
    expect(flags().heldByOther).toBe("false");
  });

  it("ignores an idle lock, which the server would let this user take", async () => {
    renderLocked({ locks: [makeLock({ idle: true })] });

    // Still names the holder for the banner, but does not gate on them.
    await waitFor(() => expect(screen.getByTestId("holder-name").textContent).toBe("Kristel"));
    expect(flags().heldByOther).toBe("false");
    expect(flags().canWrite).toBe("true");
  });

  it("does not answer a question about another section with this one's lock", async () => {
    renderLocked({ locks: [makeLock()] });

    await waitFor(() => expect(flags().canWrite).toBe("false"));
    // useCanWrite("reception") from inside the clinical section: a
    // different question, and the clinical lock is not its answer.
    expect(screen.getByTestId("can-write-elsewhere").textContent).toBe("true");
  });

  it("locks nothing outside a provider, where a false lock would look like an outage", () => {
    render(
      <AuthProvider user={makeAuthUser({ id: ME, permissions: PERMISSION_PRESETS.manager })}>
        <PermissionAreaProvider area="clinical">
          <Probe />
        </PermissionAreaProvider>
      </AuthProvider>,
    );

    expect(flags().canWrite).toBe("true");
    expect(flags().heldByOther).toBe("false");
  });
});

describe("useWriteGate explains which refusal this is", () => {
  it("names the holder when the block is the lock", async () => {
    renderLocked({ locks: [makeLock()] });

    await waitFor(() => expect(flags().title).toBe(editLockTitle("Kristel")));
    expect(flags().title).toContain("Kristel");
  });

  it("keeps the permissions message for a login that may never write here", async () => {
    renderLocked({ permissions: PERMISSION_PRESETS.readOnly, locks: [makeLock()] });

    await waitFor(() => expect(flags().heldByOther).toBe("true"));
    // Locked out AND read-only: "ask a user administrator" is the true
    // answer, because the lock is not what is stopping them.
    expect(flags().title).toBe(NO_WRITE_ACCESS_TITLE);
  });

  it("adds nothing at all when the user may write", async () => {
    renderLocked();

    await waitFor(() => expect(flags().canWrite).toBe("true"));
    expect(flags().title).toBe("none");
  });
});
