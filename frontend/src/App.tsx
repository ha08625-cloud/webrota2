import { BrowserRouter, NavLink, Route, Routes } from "react-router-dom";

import { useQueryClient } from "@tanstack/react-query";

import { triggerUnauthorized } from "@/api/client";
import { useLogout } from "@/api/auth";
import { clearToken } from "@/auth/tokenStore";
import { ClinicTypesPage } from "@/routes/ClinicTypesPage";
import { ClosuresPage } from "@/routes/ClosuresPage";
import { CountersPage } from "@/routes/CountersPage";
import { DoctorsPage } from "@/routes/DoctorsPage";
import { DutyPage } from "@/routes/DutyPage";
import { LandingPage } from "@/routes/LandingPage";
import { LeavePage } from "@/routes/LeavePage";
import { MasterRotaPage } from "@/routes/MasterRotaPage";
import { ReceptionPlaceholder } from "@/routes/ReceptionPlaceholder";
import { RotaDetailPage } from "@/routes/RotaDetailPage";
import { RotaPage } from "@/routes/RotaPage";
import { SignaturesPage } from "@/routes/SignaturesPage";
import { StagingPage } from "@/routes/StagingPage";
import { UsersPage } from "@/routes/UsersPage";

// Clinical rota nav, paths relative to the /clinical mount point.
const CLINICAL_NAV_ITEMS = [
  { to: "/clinical", label: "Generate new rotas", end: true },
  { to: "/clinical/staging", label: "Staging", end: false },
  { to: "/clinical/master-rota", label: "Master Rota", end: false },
  { to: "/clinical/clinic-types", label: "Clinic Types", end: false },
  { to: "/clinical/doctors", label: "Staff", end: false },
  { to: "/clinical/leave", label: "Assign Leave", end: false },
  { to: "/clinical/duty", label: "Assign Duty", end: false },
  { to: "/clinical/closures", label: "Closures", end: false },
  { to: "/clinical/counters", label: "Counters", end: false },
  { to: "/clinical/signatures", label: "Signatures", end: false },
  { to: "/clinical/users", label: "Users", end: false },
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

  return (
    <div className="flex min-h-screen bg-background text-ink">
      <nav className="flex w-48 shrink-0 flex-col border-r border-border bg-surface">
        <div className="px-4 py-4 text-sm font-semibold">Rota Generator</div>
        <ul className="flex-1">
          {CLINICAL_NAV_ITEMS.map((item) => (
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
        <NavLink
          to="/"
          className="border-t border-border px-4 py-3 text-left text-sm text-ink/80 hover:bg-accent/5"
        >
          Switch app
        </NavLink>
        <button
          type="button"
          onClick={handleLogout}
          disabled={isLoggingOut}
          className="border-t border-border px-4 py-3 text-left text-sm text-ink/80 hover:bg-accent/5 disabled:opacity-60"
        >
          Log out
        </button>
      </nav>
      <main className="flex-1 p-6">
        <Routes>
          <Route index element={<RotaPage />} />
          <Route path="staging" element={<StagingPage />} />
          <Route path="rota/:id" element={<RotaDetailPage />} />
          <Route path="master-rota" element={<MasterRotaPage />} />
          <Route path="clinic-types" element={<ClinicTypesPage />} />
          <Route path="doctors" element={<DoctorsPage />} />
          <Route path="leave" element={<LeavePage />} />
          <Route path="duty" element={<DutyPage />} />
          <Route path="closures" element={<ClosuresPage />} />
          <Route path="counters" element={<CountersPage />} />
          <Route path="signatures" element={<SignaturesPage />} />
          <Route path="users" element={<UsersPage />} />
        </Routes>
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
      <main className="flex-1 p-6">
        <Routes>
          <Route index element={<ReceptionPlaceholder />} />
        </Routes>
      </main>
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
      </Routes>
    </BrowserRouter>
  );
}