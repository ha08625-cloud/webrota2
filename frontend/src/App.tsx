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
import { ExtraSessionsPage } from "@/routes/ExtraSessionsPage";
import { LeavePage } from "@/routes/LeavePage";
import { MasterRotaPage } from "@/routes/MasterRotaPage";
import { RotaDetailPage } from "@/routes/RotaDetailPage";
import { RotaPage } from "@/routes/RotaPage";
import { SignaturesPage } from "@/routes/SignaturesPage";
import { StagingPage } from "@/routes/StagingPage";
import { UsersPage } from "@/routes/UsersPage";

const NAV_ITEMS = [
  { to: "/", label: "Generate new rotas", end: true },
  { to: "/staging", label: "Staging", end: false },
  { to: "/master-rota", label: "Master Rota", end: false },
  { to: "/clinic-types", label: "Clinic Types", end: false },
  { to: "/doctors", label: "Staff", end: false },
  { to: "/leave", label: "Assign Leave", end: false },
  { to: "/extra-sessions", label: "Extra Sessions", end: false },
  { to: "/duty", label: "Assign Duty", end: false },
  { to: "/closures", label: "Closures", end: false },
  { to: "/counters", label: "Counters", end: false },
  { to: "/signatures", label: "Signatures", end: false },
  { to: "/users", label: "Users", end: false },
] as const;

export function App() {
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

  return (
    <BrowserRouter>
      <div className="flex min-h-screen bg-background text-ink">
        <nav className="flex w-48 shrink-0 flex-col border-r border-border bg-surface">
          <div className="px-4 py-4 text-sm font-semibold">Rota Generator</div>
          <ul className="flex-1">
            {NAV_ITEMS.map((item) => (
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
          <button
            type="button"
            onClick={handleLogout}
            disabled={logoutMutation.isPending}
            className="border-t border-border px-4 py-3 text-left text-sm text-ink/80 hover:bg-accent/5 disabled:opacity-60"
          >
            Log out
          </button>
        </nav>
        <main className="flex-1 p-6">
          <Routes>
            <Route path="/" element={<RotaPage />} />
            <Route path="/staging" element={<StagingPage />} />
            <Route path="/rota/:id" element={<RotaDetailPage />} />
            <Route path="/master-rota" element={<MasterRotaPage />} />
            <Route path="/clinic-types" element={<ClinicTypesPage />} />
            <Route path="/doctors" element={<DoctorsPage />} />
            <Route path="/leave" element={<LeavePage />} />
            <Route path="/extra-sessions" element={<ExtraSessionsPage />} />
            <Route path="/duty" element={<DutyPage />} />
            <Route path="/closures" element={<ClosuresPage />} />
            <Route path="/counters" element={<CountersPage />} />
            <Route path="/signatures" element={<SignaturesPage />} />
            <Route path="/users" element={<UsersPage />} />
          </Routes>
        </main>
      </div>
    </BrowserRouter>
  );
}