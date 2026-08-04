import { BrowserRouter, NavLink, Route, Routes, useLocation } from "react-router-dom";

import { useQueryClient } from "@tanstack/react-query";

import { triggerUnauthorized } from "@/api/client";
import { useLogout } from "@/api/auth";
import { clearToken } from "@/auth/tokenStore";
import {
  SESSION_MANAGEMENT_PATHS,
  SESSION_MANAGEMENT_TABS,
  SessionManagementLayout,
} from "@/components/SessionManagementTabs";
import { ClinicTypesPage } from "@/routes/ClinicTypesPage";
import { ClosuresPage } from "@/routes/ClosuresPage";
import { CountersPage } from "@/routes/CountersPage";
import { DoctorsPage } from "@/routes/DoctorsPage";
import { DutyPage } from "@/routes/DutyPage";
import { ExtraSessionsPage } from "@/routes/ExtraSessionsPage";
import { LandingPage } from "@/routes/LandingPage";
import { LeavePage } from "@/routes/LeavePage";
import { LeavePlanningPage } from "@/routes/LeavePlanningPage";
import { MasterRotaPage } from "@/routes/MasterRotaPage";
import { ReceptionCoverageRulesPage } from "@/routes/ReceptionCoverageRulesPage";
import { ReceptionDayPage } from "@/routes/ReceptionDayPage";
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
  { to: "/clinical/users", label: "Users", end: false },
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
  { to: "/reception/coverage-rules", label: "Coverage Rules", end: false },
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
 
function ClinicalShell() {
  const { handleLogout, isLoggingOut } = useHandleLogout();
  const { pathname } = useLocation();

  return (
    <div className="flex min-h-screen flex-col bg-background text-ink">
      <div className="flex items-center justify-between border-b border-border bg-surface px-4 py-3">
        <span className="text-sm font-semibold">Rota Generator</span>
        <div className="flex items-center gap-4">
          <NavLink to="/" className="text-sm text-ink/80 hover:text-accent">
            Switch app
          </NavLink>
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
            <Route path="users" element={<UsersPage />} />
          </Routes>
        </main>
      </div>
    </div>
  );
}
 
/**
 * Signatures is admin-staff tooling, not part of either rota, so it gets
 * its own top-level page reachable from the landing page rather than
 * living under the clinical section.
 */
function SignaturesShell() {
  const { handleLogout, isLoggingOut } = useHandleLogout();

  return (
    <div className="flex min-h-screen flex-col bg-background text-ink">
      <div className="flex items-center justify-between border-b border-border bg-surface px-4 py-3">
        <span className="text-sm font-semibold">Rota Generator - Signatures</span>
        <div className="flex items-center gap-4">
          <NavLink to="/" className="text-sm text-ink/80 hover:text-accent">
            Switch app
          </NavLink>
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
      <main className="flex-1 p-6">
        <SignaturesPage />
      </main>
    </div>
  );
}

function ReceptionShell() {
  const { handleLogout, isLoggingOut } = useHandleLogout();
 
  return (
    <div className="flex min-h-screen flex-col bg-background text-ink">
      <div className="flex items-center justify-between border-b border-border bg-surface px-4 py-3">
        <span className="text-sm font-semibold">Rota Generator - Reception</span>
        <div className="flex items-center gap-4">
          <NavLink to="/" className="text-sm text-ink/80 hover:text-accent">
            Switch app
          </NavLink>
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
          <Routes>
            <Route index element={<ReceptionDayPage />} />
            <Route path="master" element={<ReceptionMasterPage />} />
            <Route path="leave" element={<ReceptionLeavePage />} />
            <Route path="staff" element={<ReceptionStaffPage />} />
            <Route path="coverage-rules" element={<ReceptionCoverageRulesPage />} />
          </Routes>
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
        <Route path="/clinical/*" element={<ClinicalShell />} />
        <Route path="/reception/*" element={<ReceptionShell />} />
        <Route path="/signatures" element={<SignaturesShell />} />
      </Routes>
    </BrowserRouter>
  );
}
 