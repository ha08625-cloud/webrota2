import { BrowserRouter, Navigate, NavLink, Route, Routes, useLocation } from "react-router-dom";

import { useQueryClient } from "@tanstack/react-query";

import { triggerUnauthorized } from "@/api/client";
import { useLogout } from "@/api/auth";
import {
  PermissionAreaProvider,
  canReadArea,
  canWriteArea,
  usePermissions,
} from "@/auth/AuthContext";
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
import { CommittedRotasPage } from "@/routes/CommittedRotasPage";
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
  /**
   * Hide this entry from a login that can only read the clinical section.
   * A reader's business with the clinical rota is the published rota, the
   * session-planning pages behind Session Management and their own calendar
   * link; the reference-data pages (Master Rota, Clinic Types, Staff, Assign
   * Duty, Meetings, Counters) are editing tools whose controls would all be
   * disabled for them, so they are hidden rather than shown inert.
   */
  writeOnly?: boolean;
  /**
   * The mirror of `writeOnly`: hide this entry from a login that can write in
   * the clinical section. Set only on Committed Rotas, which is a reader's
   * view of the published rota. A writer reaches every rota, committed ones
   * included, through the generate console's commit history and the rota
   * detail page it links to, so the entry would be a second, weaker route to
   * something they already have.
   */
  readerOnly?: boolean;
}

// The nav is filtered by one thing only: whether the login can write in the
// clinical section. A writer sees every entry bar Committed Rotas; a reader
// sees the three that are useful without edit rights (Committed Rotas,
// Session Management and Calendar Feed) and none of the reference-data
// pages, whose every control would be disabled for them.
// CLINICAL_WRITE_ONLY_PATHS and CLINICAL_READER_ONLY_PATHS guard the matching
// routes, so hiding an entry also blocks the bookmark behind it. The two
// entries that used to be filtered, Users and Audit Log, are their own
// section now.
//
// "Generate new rotas" is write-only too, even though it is the section
// index: it is a generation console (staging form, duty preview, clinic
// enable checkboxes, commit history) and none of it is usable, or
// relevant, without edit rights. Readers get Committed Rotas in its place
// - see CLINICAL_READER_HOME.

// Clinical rota nav. The five session-planning pages are grouped behind one
// "Session Management" entry and switched between with the sub-tab bar in
// SessionManagementTabs.tsx; their routes are unchanged.
const CLINICAL_NAV_ITEMS: readonly NavItem[] = [
  { to: "/clinical/committed", label: "Committed Rotas", end: false, readerOnly: true },
  { to: "/clinical", label: "Generate new rotas", end: true, writeOnly: true },
  { to: "/clinical/master-rota", label: "Master Rota", end: false, writeOnly: true },
  { to: "/clinical/clinic-types", label: "Clinic Types", end: false, writeOnly: true },
  { to: "/clinical/doctors", label: "Staff", end: false, writeOnly: true },
  {
    to: SESSION_MANAGEMENT_TABS[0].to,
    label: "Session Management",
    end: false,
    groupPaths: SESSION_MANAGEMENT_PATHS,
  },
  { to: "/clinical/duty", label: "Assign Duty", end: false, writeOnly: true },
  { to: "/clinical/recurring-notes", label: "Meetings", end: false, writeOnly: true },
  { to: "/clinical/counters", label: "Counters", end: false, writeOnly: true },
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

/**
 * Where a clinical reader is sent when they land on a page they cannot use,
 * including the section index. Must not itself be a `writeOnly` path, or
 * the redirect below would loop.
 */
const CLINICAL_READER_HOME = "/clinical/committed";

/**
 * The clinical routes a reader is kept out of, matching the `writeOnly` nav
 * entries above. Listed here as well so that hiding a link and blocking the
 * route it pointed at cannot drift apart, and so a bookmark or a hand-typed
 * URL lands on the page a reader does want rather than on a page of
 * controls the login cannot use.
 */
const CLINICAL_WRITE_ONLY_PATHS: readonly string[] = CLINICAL_NAV_ITEMS.filter(
  (item) => item.writeOnly,
).map((item) => item.to);

/**
 * The mirror of the above: clinical routes a writer is kept out of, matching
 * the `readerOnly` nav entries. A writer who follows an old link to the
 * committed-rota view lands on the generate console, whose commit history is
 * the writer's way into the same rotas.
 */
const CLINICAL_WRITER_EXCLUDED_PATHS: readonly string[] = CLINICAL_NAV_ITEMS.filter(
  (item) => item.readerOnly,
).map((item) => item.to);

/** Where a writer bounced off a `readerOnly` path is sent. */
const CLINICAL_WRITER_HOME = "/clinical";

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
  const canWrite = canWriteArea(permissions, "clinical");
  const navItems = CLINICAL_NAV_ITEMS.filter((item) =>
    canWrite ? !item.readerOnly : !item.writeOnly,
  );

  // Reads are gated too, so a bookmark into a section the user cannot see
  // would otherwise render a page of failed queries. Back to the landing
  // page, which shows what they can reach. The API 403 is still the
  // boundary; this is only UX.
  if (!canReadArea(permissions, "clinical")) {
    return <Navigate to="/" replace />;
  }

  // Same idea one level down: a reader who bookmarked a write-only page -
  // the section index among them - goes to the committed-rota view rather
  // than the landing page. They can still read the clinical section, just
  // not that page.
  if (!canWrite && CLINICAL_WRITE_ONLY_PATHS.includes(pathname)) {
    return <Navigate to={CLINICAL_READER_HOME} replace />;
  }

  // And the mirror of it: a writer who lands on the reader's committed-rota
  // view goes to the generate console, where the commit history and the rota
  // detail page behind it cover the same ground with the editing controls
  // their login is for.
  if (canWrite && CLINICAL_WRITER_EXCLUDED_PATHS.includes(pathname)) {
    return <Navigate to={CLINICAL_WRITER_HOME} replace />;
  }

  return (
    <div className="flex min-h-screen flex-col bg-background text-ink">
      <ShellHeader title="Rota Generator" />
      <div className="flex flex-1">
        <nav className="flex w-48 shrink-0 flex-col border-r border-border bg-surface">
          <ul>
            {navItems.map((item) => (
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
              <Route path="committed" element={<CommittedRotasPage />} />
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
 