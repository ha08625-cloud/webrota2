import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import type { AccessLevel } from "@/api/types";
import { makeAuthUser } from "@/test/fixtures/reference";

import { AuthProvider, useAuth } from "./AuthContext";

function Probe() {
  const { user, canWrite, isManager } = useAuth();
  return (
    <ul>
      <li data-testid="email">{user?.email ?? "none"}</li>
      <li data-testid="can-write">{String(canWrite)}</li>
      <li data-testid="is-manager">{String(isManager)}</li>
    </ul>
  );
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
