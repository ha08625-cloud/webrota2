import React from "react";
import ReactDOM from "react-dom/client";
 
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
 
import { App } from "./App";
import { LoginGate } from "./auth/LoginGate";
import { applyContrast, applyTheme, getContrast } from "./lib/themeStore";
import "./index.css";
 
const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // Default TanStack Query behaviour retries every failure 3 times,
      // including 401s - which will never succeed and just delays the
      // login form appearing by several seconds. Skip retries for any 4xx
      // (client error, not transient); keep a couple of retries for
      // 5xx/network failures, which might be.
      retry: (failureCount, error) => {
        const status = error?.status;
        if (typeof status === "number" && status >= 400 && status < 500) {
          return false;
        }
        return failureCount < 2;
      },
    },
  },
});
 
// Applied here rather than in a React effect: an effect runs after the
// first paint, so every load would flash the default theme before
// switching to the stored one.
//
// The palette picker is retired while the palettes are refined, so the
// stored choice is deliberately ignored and the default is forced - a user
// who picked a palette before it was hidden gets the default back rather
// than being stuck on a theme with no way to change it. Restore this to
// applyTheme(getTheme()) when the picker comes back.
applyTheme("default");
applyContrast(getContrast());

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <LoginGate>
        <App />
      </LoginGate>
    </QueryClientProvider>
  </React.StrictMode>,
);