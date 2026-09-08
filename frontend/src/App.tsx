import { BrowserRouter, Navigate, NavLink, Route, Routes, useLocation } from "react-router-dom";

import { useQueryClient } from "@tanstack/react-query";

import { triggerUnauthorized } from "@/api/client";
import { useLogout } from "@/api/auth";
import { PermissionAreaProvider, canReadArea, usePermissions } from "@/auth/AuthContext";
import { clearToken } from "@/auth/tokenStore";
import { ChangePasswordDialog } from "@/components/ChangePasswordDialog";
import { ThemePicker } from "@/components/ThemePicker";
import {
  SESSION_MANAGEMENT_PATHS,
  SESSION_MANAGEMENT_TABS,
  SessionManagementLayout,
} from "@/components/SessionManagementTabs";
import { SignaturesLayout } from "@/components/SignaturesTabs";
import { AuditLogPage } from "@/routes/AuditLogPage";
import { CalendarFeedPage } from "@/routes/CalendarFeedPage";
import { ClinicTypesPage } from "@/routes/ClinicTypesPage";
import { ClosuresPage } from "@/routes/ClosuresPage";
import { CountersPage } from "@/routes/CountersPage";
import { DoctorsPage } from "@/routes/DoctorsPage";
import { DutyPage } from "@/routes/DutyPage";
import { EoiPage } from "@/routes/EoiPage";
import { ExtraSessionsPage } from "@/routes/ExtraSessionsPage";
import { LandingPage } from "@/routes/LandingPage";
import { LeavePage } from "@/routes/LeavePage";
import { LeavePlanningPage } from "@/routes/LeavePlanningPage";
import { MasterRotaPage } from "@/routes/MasterRotaPage";
import { ReceptionDayPage } from "@/routes/ReceptionDayPage";
import { ReceptionCountersPage } from "@/routes/ReceptionCountersPage";
import { ReceptionLeavePage } from "@/routes/ReceptionLeavePage";
import { ReceptionMasterPage } from "@/routes/ReceptionMasterPage";
import { ReceptionStaffPage } from "@/routes/ReceptionStaffPage";
import { RecurringNotesPage } from "@/routes/RecurringNotesPage";
import { RotaDetailPage } from "@/routes/RotaDetailPage";
import { RotaPage } from "@/routes/RotaPage";
import { SchoolHolidaysPage } from "@/routes/SchoolHolidaysPage";
import { SignaturesPage } from "@/routes/SignaturesPage";
import { StagingPage } from "@/routes/StagingPage";
import { UsersPage } from "@/routes/UsersPage";
 
interface NavItem {
  to: string;
  label: string;
  end: boolean;
  /**
   * Extra paths that should also mark this entry active. Set only for the
   * grouped "Session Management" entry: its sub-tabs are sibling paths, which
   * NavLink's own isActive can never match, so the group would un-highlight as
   * soon as you switched sub-tab.
   */
  groupPaths?: readonly string[];
}

// No nav entry is permission-filtered any more: reaching a section at all is
// the shell's guard, and within a section the user can read, every page is
// worth reading - so the nav is the same for a reader and a writer, and it is
// the controls inside each page that go quiet. The two entries that used to be
// filtered, Users and Audit Log, are their own section now.

// Clinical rota nav. The five session-planning pages are grouped behind one
// "Session Management" entry and switched between with the sub-tab bar in
// SessionManagementTabs.tsx; their routes are unchanged.
const CLINICAL_NAV_ITEMS: readonly NavItem[] = [
  { to: "/clinical", label: "Generate new rotas", end: true },
  { to: "/clinical/staging", label: "Staging", end: false },
  { to: "/clinical/master-rota", label: "Master Rota", end: false },
  { to: "/clinical/clinic-types", label: "Clinic Types", end: false },
  { to: "/clinical/doctors", label: "Staff", end: false },
  {
    to: SESSION_MANAGEMENT_TABS[0].to,
    label: "Session Management",
    end: false,
    groupPaths: SESSION_MANAGEMENT_PATHS,
  },
  { to: "/clinical/duty", label: "Assign Duty", end: false },
  { to: "/clinical/recurring-notes", label: "Recurring Notes", end: false },
  { to: "/clinical/counters", label: "Counters", end: false },
  // No `requires`: anyone who can read the clinical section reads this page
  // and copies their link. Only the "issue a new link" button inside it
  // needs the user administration permission.
  { to: "/clinical/calendar", label: "Calendar Feed", end: false },
];

// Administration nav. Users and Audit Log used to live in the clinical
// section; they moved out because `user_admin` is independent of the
// clinical permission, so the clinical shell's read guard would otherwise
// lock a user-administration-only login out of the two pages it grants.
const ADMIN_NAV_ITEMS: readonly NavItem[] = [
  { to: "/admin/users", label: "Users", end: false },
  { to: "/admin/audit", label: "Audit Log", end: false },
];

function navLinkClass(isActive: boolean) {
  return `block px-4 py-2 text-sm ${
    isActive ? "bg-accent/10 font-medium text-accent" : "text-ink/80 hover:bg-accent/5"
  }`;
}

// Reception nav, paths relative to the /reception mount point. Built the
// same way as CLINICAL_NAV_ITEMS above - see App.tsx's Task 5 plan.
const RECEPTION_NAV_ITEMS = [
  { to: "/reception", label: "Day Rota", end: true },
  { to: "/reception/master", label: "Master Template", end: false },
  { to: "/reception/leave", label: "Leave", end: false },
  { to: "/reception/staff", label: "Reception Staff", end: false },
  { to: "/reception/counters", label: "Counters", end: false },
] as const;

/**
 * Logout is identical regardless of section, so it is lifted out of the
 * per-section shell rather than duplicated once a reception shell exists.
 */
function useHandleLogout() {
  const queryClient = useQueryClient();
  const logoutMutation = useLogout();
 
  async function handleLogout() {
    // Best-effort session deletion server-side; a network failure here
    // must not block the user from getting back to the login form -
    // the client-side token is cleared regardless (auth plan, Task 5).
    try {
      await logoutMutation.mutateAsync();
    } catch {
      // ignore - see comment above
    }
    clearToken();
    queryClient.clear();
    triggerUnauthorized();
  }
 
  return { handleLogout, isLoggingOut: logoutMutation.isPending };
}
 
/**
 * The bar every section shares: its own name, a way back to the landing
 * page, the self-service password form and log out. Identical in all four
 * shells bar the title, so it lives here rather than being copied per
 * section.
 */
function ShellHeader({ title }: { title: string }) {
  const { handleLogout, isLoggingOut } = useHandleLogout();

  return (
    <div className="flex items-center justify-between border-b border-border bg-surface px-4 py-3">
      <span className="text-sm font-semibold">{title}</span>
      <div className="flex items-center gap-4">
        <NavLink to="/" className="text-sm text-ink/80 hover:text-accent">
          Switch app
        </NavLink>
        <ThemePicker />
        {/* Open to every permission set - user management needs the user
            administration permission, so this is the only way most logins
            can change their own password. */}
        <ChangePasswordDialog />
        <button
          type="button"
          onClick={handleLogout}
          disabled={isLoggingOut}
          className="text-sm text-ink/80 hover:text-accent disabled:opacity-60"
        >
          Log out
        </button>
      </div>
    </div>
  );
}

function ClinicalShell() {
  const { pathname } = useLocation();
  const permissions = usePermissions();

  // Reads are gated too, so a bookmark into a section the user cannot see
  // would otherwise render a page of failed queries. Back to the landing
  // page, which shows what they can reach. The API 403 is still the
  // boundary; this is only UX.
  if (!canReadArea(permissions, "clinical")) {
    return <Navigate to="/" replace />;
  }

  return (
    <div className="flex min-h-screen flex-col bg-background text-ink">
      <ShellHeader title="Rota Generator" />
      <div className="flex flex-1">
        <nav className="flex w-48 shrink-0 flex-col border-r border-border bg-surface">
          <ul>
            {CLINICAL_NAV_ITEMS.map((item) => (
              <li key={item.to}>
                <NavLink
                  to={item.to}
                  end={item.end}
                  className={({ isActive }) =>
                    navLinkClass(isActive || (item.groupPaths?.includes(pathname) ?? false))
                  }
                >
                  {item.label}
                </NavLink>
              </li>
            ))}
          </ul>
        </nav>
        <main className="flex-1 p-6">
          {/* One provider for the whole section, so every page and grid below
              can ask useCanWrite() with no argument and get the clinical
              answer. */}
          <PermissionAreaProvider area="clinical">
            <Routes>
              <Route index element={<RotaPage />} />
              <Route path="staging" element={<StagingPage />} />
              <Route path="rota/:id" element={<RotaDetailPage />} />
              <Route path="master-rota" element={<MasterRotaPage />} />
              <Route path="clinic-types" element={<ClinicTypesPage />} />
              <Route path="doctors" element={<DoctorsPage />} />
              {/* Session Management group - one layout route so the sub-tab bar
                  is rendered in a single place, above whichever page is active. */}
              <Route element={<SessionManagementLayout />}>
                <Route path="leave-planning" element={<LeavePlanningPage />} />
                <Route path="leave" element={<LeavePage />} />
                <Route path="extra-sessions" element={<ExtraSessionsPage />} />
                <Route path="closures" element={<ClosuresPage />} />
                <Route path="school-holidays" element={<SchoolHolidaysPage />} />
              </Route>
              <Route path="duty" element={<DutyPage />} />
              <Route path="recurring-notes" element={<RecurringNotesPage />} />
              <Route path="counters" element={<CountersPage />} />
              <Route path="calendar" element={<CalendarFeedPage />} />
            </Routes>
          </PermissionAreaProvider>
        </main>
      </div>
    </div>
  );
}
 
/**
 * Document tooling (signatures, Study EOI autofill) is admin-staff work,
 * not part of either rota, so it gets its own top-level section reachable
 * from the landing page rather than living under the clinical section. The
 * pages inside it are switched with a sub-tab bar, not a left nav.
 */
function SignaturesShell() {
  const permissions = usePermissions();

  // The two pages are two independent permissions, so the section is
  // reachable on either one and its tab bar shows only what is held.
  if (!permissions.signatures && !permissions.study_eoi) {
    return <Navigate to="/" replace />;
  }

  return (
    <div className="flex min-h-screen flex-col bg-background text-ink">
      <ShellHeader title="Rota Generator - Documents" />
      <main className="flex-1 p-6">
        <Routes>
          {/* One layout route so the sub-tab bar is rendered in a single
              place, above whichever page is active. Signatures is the index
              route, so the pre-existing /signatures bookmark still lands on
              it. The area provider goes on each route rather than on the
              shell: unlike the rota sections, these two pages are two
              different permissions, and a login may hold just one. */}
          <Route element={<SignaturesLayout />}>
            <Route
              index
              element={
                permissions.signatures ? (
                  <PermissionAreaProvider area="signatures">
                    <SignaturesPage />
                  </PermissionAreaProvider>
                ) : (
                  <Navigate to="/signatures/eoi" replace />
                )
              }
            />
            <Route
              path="eoi"
              element={
                permissions.study_eoi ? (
                  <PermissionAreaProvider area="study_eoi">
                    <EoiPage />
                  </PermissionAreaProvider>
                ) : (
                  <Navigate to="/signatures" replace />
                )
              }
            />
          </Route>
        </Routes>
      </main>
    </div>
  );
}

function ReceptionShell() {
  const permissions = usePermissions();

  if (!canReadArea(permissions, "reception")) {
    return <Navigate to="/" replace />;
  }

  return (
    <div className="flex min-h-screen flex-col bg-background text-ink">
      <ShellHeader title="Rota Generator - Reception" />
      <div className="flex flex-1">
        <nav className="flex w-48 shrink-0 flex-col border-r border-border bg-surface">
          <ul className="flex-1">
            {RECEPTION_NAV_ITEMS.map((item) => (
              <li key={item.to}>
                <NavLink
                  to={item.to}
                  end={item.end}
                  className={({ isActive }) =>
                    `block px-4 py-2 text-sm ${
                      isActive ? "bg-accent/10 font-medium text-accent" : "text-ink/80 hover:bg-accent/5"
                    }`
                  }
                >
                  {item.label}
                </NavLink>
              </li>
            ))}
          </ul>
        </nav>
        <main className="flex-1 p-6">
          <PermissionAreaProvider area="reception">
            <Routes>
              <Route index element={<ReceptionDayPage />} />
              <Route path="master" element={<ReceptionMasterPage />} />
              <Route path="leave" element={<ReceptionLeavePage />} />
              <Route path="staff" element={<ReceptionStaffPage />} />
              <Route path="counters" element={<ReceptionCountersPage />} />
            </Routes>
          </PermissionAreaProvider>
        </main>
      </div>
    </div>
  );
}
 
/**
 * User management and the audit log. Its own section rather than two pages
 * inside the clinical one, because `user_admin` is an independent
 * permission: the login this feature exists to make possible - one that can
 * administer users and nothing else - has no clinical access to hang them
 * off.
 */
function AdminShell() {
  const permissions = usePermissions();

  if (!permissions.user_admin) {
    return <Navigate to="/" replace />;
  }

  return (
    <div className="flex min-h-screen flex-col bg-background text-ink">
      <ShellHeader title="Rota Generator - Administration" />
      <div className="flex flex-1">
        <nav className="flex w-48 shrink-0 flex-col border-r border-border bg-surface">
          <ul>
            {ADMIN_NAV_ITEMS.map((item) => (
              <li key={item.to}>
                <NavLink
                  to={item.to}
                  end={item.end}
                  className={({ isActive }) => navLinkClass(isActive)}
                >
                  {item.label}
                </NavLink>
              </li>
            ))}
          </ul>
        </nav>
        <main className="flex-1 p-6">
          <PermissionAreaProvider area="user_admin">
            <Routes>
              <Route index element={<Navigate to="/admin/users" replace />} />
              <Route path="users" element={<UsersPage />} />
              <Route path="audit" element={<AuditLogPage />} />
            </Routes>
          </PermissionAreaProvider>
        </main>
      </div>
    </div>
  );
}

export function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<LandingPage />} />
        {/* Ranked above /clinical/* by the router (a static segment beats a
            splat), which is what these need: they must not go through
            ClinicalShell's read guard, since the login they exist for - user
            administration only - cannot read the clinical section. */}
        <Route path="/clinical/users" element={<Navigate to="/admin/users" replace />} />
        <Route path="/clinical/audit" element={<Navigate to="/admin/audit" replace />} />
        <Route path="/clinical/*" element={<ClinicalShell />} />
        <Route path="/reception/*" element={<ReceptionShell />} />
        <Route path="/signatures/*" element={<SignaturesShell />} />
        <Route path="/admin/*" element={<AdminShell />} />
      </Routes>
    </BrowserRouter>
  );
}
 