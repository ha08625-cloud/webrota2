import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import type { Permissions } from "@/api/types";
import { PERMISSION_PRESETS, makeAuthUser } from "@/test/fixtures/reference";

import {
  AuthProvider,
  PermissionAreaProvider,
  useAuth,
  useCanAdminUsers,
  useCanRead,
  useCanWrite,
  useLinkedDoctorId,
  useLinkedReceptionStaffId,
  type PermissionArea,
} from "./AuthContext";

function Probe() {
  const { user } = useAuth();
  // Through the hooks, which is how components read these.
  return (
    <ul>
      <li data-testid="email">{user?.email ?? "none"}</li>
      <li data-testid="can-write">{String(useCanWrite())}</li>
      <li data-testid="can-read">{String(useCanRead())}</li>
      <li data-testid="can-admin-users">{String(useCanAdminUsers())}</li>
      <li data-testid="linked-doctor">{String(useLinkedDoctorId())}</li>
      <li data-testid="linked-reception">{String(useLinkedReceptionStaffId())}</li>
    </ul>
  );
}

function links() {
  return {
    doctor: screen.getByTestId("linked-doctor").textContent,
    reception: screen.getByTestId("linked-reception").textContent,
  };
}

function flags() {
  return {
    canWrite: screen.getByTestId("can-write").textContent,
    canRead: screen.getByTestId("can-read").textContent,
    canAdminUsers: screen.getByTestId("can-admin-users").textContent,
  };
}

function renderWith(permissions: Permissions, area: PermissionArea = "clinical") {
  render(
    <AuthProvider user={makeAuthUser({ email: "jo@example.com", permissions })}>
      <PermissionAreaProvider area={area}>
        <Probe />
      </PermissionAreaProvider>
    </AuthProvider>,
  );
}

describe("AuthContext permissions", () => {
  it("gives write and read in an area granted write", () => {
    renderWith(PERMISSION_PRESETS.manager);
    expect(flags()).toEqual({ canWrite: "true", canRead: "true", canAdminUsers: "true" });
  });

  it("gives read but not write in an area granted read", () => {
    renderWith(PERMISSION_PRESETS.receptionAdmin, "clinical");
    expect(flags()).toEqual({ canWrite: "false", canRead: "true", canAdminUsers: "false" });
  });

  it("gives neither in an area granted none", () => {
    renderWith(PERMISSION_PRESETS.documents, "clinical");
    expect(flags()).toEqual({ canWrite: "false", canRead: "false", canAdminUsers: "false" });
  });

  // The same permission set read from two sections: what a component may do
  // depends on where it is mounted, which is the point of the area context.
  it("answers per area, not per user", () => {
    renderWith(PERMISSION_PRESETS.receptionAdmin, "reception");
    expect(flags()).toEqual({ canWrite: "true", canRead: "true", canAdminUsers: "false" });
  });

  // A boolean permission has no read-only level: holding it grants both, and
  // the backend agrees - false denies GETs too.
  it("grants a boolean permission both read and write", () => {
    renderWith(PERMISSION_PRESETS.documents, "signatures");
    expect(flags()).toEqual({ canWrite: "true", canRead: "true", canAdminUsers: "false" });
  });

  it("denies a boolean permission both read and write", () => {
    renderWith(PERMISSION_PRESETS.receptionAdmin, "signatures");
    expect(flags()).toEqual({ canWrite: "false", canRead: "false", canAdminUsers: "false" });
  });

  it("exposes the user itself", () => {
    renderWith(PERMISSION_PRESETS.manager);
    expect(screen.getByTestId("email")).toHaveTextContent("jo@example.com");
  });

  // access_level is a label: a "nurse" whose permission set says write may
  // write, because nothing reads the tier.
  it("ignores access_level entirely", () => {
    render(
      <AuthProvider
        user={makeAuthUser({ access_level: "nurse", permissions: PERMISSION_PRESETS.manager })}
      >
        <PermissionAreaProvider area="clinical">
          <Probe />
        </PermissionAreaProvider>
      </AuthProvider>,
    );
    expect(flags()).toEqual({ canWrite: "true", canRead: "true", canAdminUsers: "true" });
  });

  it("denies everything when there is no user yet", () => {
    render(
      <AuthProvider user={null}>
        <PermissionAreaProvider area="clinical">
          <Probe />
        </PermissionAreaProvider>
      </AuthProvider>,
    );
    expect(flags()).toEqual({ canWrite: "false", canRead: "false", canAdminUsers: "false" });
  });

  it("denies everything outside a provider, rather than defaulting open", () => {
    render(<Probe />);
    expect(flags()).toEqual({ canWrite: "false", canRead: "false", canAdminUsers: "false" });
  });

  // The other half of deny-by-default: an auth provider but no section, so
  // there is no area to judge the question against. A component that asks
  // anyway gets "no" rather than being judged against an arbitrary area.
  it("denies read and write with no area in context, even for a full permission set", () => {
    render(
      <AuthProvider user={makeAuthUser({ permissions: PERMISSION_PRESETS.manager })}>
        <Probe />
      </AuthProvider>,
    );
    expect(flags()).toEqual({
      canWrite: "false",
      canRead: "false",
      // Not area-scoped: user_admin is one flag on the user, so it answers
      // wherever it is asked.
      canAdminUsers: "true",
    });
  });
});

// The link is identity, not permission: these tests deliberately give a
// no-rota-access user a doctor link, the combination that would break if
// anyone ever derived one from the other.
describe("AuthContext staff links", () => {
  it("unwraps both linked ids for a linked user", () => {
    render(
      <AuthProvider
        user={makeAuthUser({
          permissions: PERMISSION_PRESETS.documents,
          linked_doctor: { id: 3, code: "AB", active: true },
          linked_reception_staff: { id: 7, code: "Emily M", active: false },
        })}
      >
        <PermissionAreaProvider area="clinical">
          <Probe />
        </PermissionAreaProvider>
      </AuthProvider>,
    );

    expect(links()).toEqual({ doctor: "3", reception: "7" });
    // ...and the permissions are untouched by having a link.
    expect(flags()).toEqual({ canWrite: "false", canRead: "false", canAdminUsers: "false" });
  });

  it("gives null for an unlinked user", () => {
    renderWith(PERMISSION_PRESETS.manager);
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
