import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import type { AccessLevel } from "@/api/types";
import { makeAuthUser } from "@/test/fixtures/reference";

import {
  AuthProvider,
  useAuth,
  useLinkedDoctorId,
  useLinkedReceptionStaffId,
} from "./AuthContext";

function Probe() {
  const { user, canWrite, isManager } = useAuth();
  // Through the hooks, which is how components read these.
  const linkedDoctorId = useLinkedDoctorId();
  const linkedReceptionStaffId = useLinkedReceptionStaffId();
  return (
    <ul>
      <li data-testid="email">{user?.email ?? "none"}</li>
      <li data-testid="can-write">{String(canWrite)}</li>
      <li data-testid="is-manager">{String(isManager)}</li>
      <li data-testid="linked-doctor">{String(linkedDoctorId)}</li>
      <li data-testid="linked-reception">{String(linkedReceptionStaffId)}</li>
    </ul>
  );
}

function links() {
  return {
    doctor: screen.getByTestId("linked-doctor").textContent,
    reception: screen.getByTestId("linked-reception").textContent,
  };
}

function renderAs(accessLevel: AccessLevel) {
  render(
    <AuthProvider user={makeAuthUser({ email: "jo@example.com", access_level: accessLevel })}>
      <Probe />
    </AuthProvider>,
  );
}

function flags() {
  return {
    canWrite: screen.getByTestId("can-write").textContent,
    isManager: screen.getByTestId("is-manager").textContent,
  };
}

describe("AuthContext tiers", () => {
  it("gives a manager both write and user-management access", () => {
    renderAs("manager");
    expect(flags()).toEqual({ canWrite: "true", isManager: "true" });
  });

  it("gives an admin writes but not user management", () => {
    renderAs("admin");
    expect(flags()).toEqual({ canWrite: "true", isManager: "false" });
  });

  // Doctor and nurse are permission-identical by design - they are labels
  // over one read-only tier, not two tiers.
  it.each(["doctor", "nurse"] as const)("gives a %s neither", (level) => {
    renderAs(level);
    expect(flags()).toEqual({ canWrite: "false", isManager: "false" });
  });

  it("exposes the user itself", () => {
    renderAs("admin");
    expect(screen.getByTestId("email")).toHaveTextContent("jo@example.com");
  });

  it("denies everything when there is no user yet", () => {
    render(
      <AuthProvider user={null}>
        <Probe />
      </AuthProvider>,
    );
    expect(flags()).toEqual({ canWrite: "false", isManager: "false" });
  });

  it("denies everything outside a provider, rather than defaulting open", () => {
    render(<Probe />);
    expect(flags()).toEqual({ canWrite: "false", isManager: "false" });
  });
});

// The link is identity, not permission: these tests deliberately use a
// nurse-tier user with a doctor link, the combination that would break if
// anyone ever derived one from the other (staff linking, D3).
describe("AuthContext staff links", () => {
  it("unwraps both linked ids for a linked user", () => {
    render(
      <AuthProvider
        user={makeAuthUser({
          access_level: "nurse",
          linked_doctor: { id: 3, code: "AB", active: true },
          linked_reception_staff: { id: 7, code: "Emily M", active: false },
        })}
      >
        <Probe />
      </AuthProvider>,
    );

    expect(links()).toEqual({ doctor: "3", reception: "7" });
    // ...and the tier is untouched by having a link.
    expect(flags()).toEqual({ canWrite: "false", isManager: "false" });
  });

  it("gives null for an unlinked user", () => {
    renderAs("manager");
    expect(links()).toEqual({ doctor: "null", reception: "null" });
  });

  it("gives null when there is no user yet", () => {
    render(
      <AuthProvider user={null}>
        <Probe />
      </AuthProvider>,
    );
    expect(links()).toEqual({ doctor: "null", reception: "null" });
  });

  it("gives null outside a provider, rather than someone else's identity", () => {
    render(<Probe />);
    expect(links()).toEqual({ doctor: "null", reception: "null" });
  });
});
