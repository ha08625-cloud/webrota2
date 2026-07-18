import { BrowserRouter, NavLink, Route, Routes } from "react-router-dom";

import { ClinicTypesPage } from "@/routes/ClinicTypesPage";
import { ClosuresPage } from "@/routes/ClosuresPage";
import { CountersPage } from "@/routes/CountersPage";
import { DoctorsPage } from "@/routes/DoctorsPage";
import { DutyPage } from "@/routes/DutyPage";
import { LeavePage } from "@/routes/LeavePage";
import { MasterRotaPage } from "@/routes/MasterRotaPage";
import { RotaDetailPage } from "@/routes/RotaDetailPage";
import { RotaPage } from "@/routes/RotaPage";
import { SignaturesPage } from "@/routes/SignaturesPage";

const NAV_ITEMS = [
  { to: "/", label: "Generate new rotas", end: true },
  { to: "/master-rota", label: "Master Rota", end: false },
  { to: "/clinic-types", label: "Clinic Types", end: false },
  { to: "/doctors", label: "Staff", end: false },
  { to: "/leave", label: "Assign Leave", end: false },
  { to: "/duty", label: "Assign Duty", end: false },
  { to: "/closures", label: "Closures", end: false },
  { to: "/counters", label: "Counters", end: false },
  { to: "/signatures", label: "Signatures", end: false },
] as const;

export function App() {
  return (
    <BrowserRouter>
      <div className="flex min-h-screen bg-background text-ink">
        <nav className="w-48 shrink-0 border-r border-border bg-surface">
          <div className="px-4 py-4 text-sm font-semibold">Rota Generator</div>
          <ul>
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
        </nav>
        <main className="flex-1 p-6">
          <Routes>
            <Route path="/" element={<RotaPage />} />
            <Route path="/rota/:id" element={<RotaDetailPage />} />
            <Route path="/master-rota" element={<MasterRotaPage />} />
            <Route path="/clinic-types" element={<ClinicTypesPage />} />
            <Route path="/doctors" element={<DoctorsPage />} />
            <Route path="/leave" element={<LeavePage />} />
            <Route path="/duty" element={<DutyPage />} />
            <Route path="/closures" element={<ClosuresPage />} />
            <Route path="/counters" element={<CountersPage />} />
            <Route path="/signatures" element={<SignaturesPage />} />
          </Routes>
        </main>
      </div>
    </BrowserRouter>
  );
}