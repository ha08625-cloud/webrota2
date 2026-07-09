import React from "react";
import ReactDOM from "react-dom/client";
 
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
 
import { App } from "./App";
import type { ApiError } from "./api/types";
import { TokenGate } from "./auth/TokenGate";
import "./index.css";
 
const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // Default TanStack Query behaviour retries every failure 3 times,
      // including 401s - which will never succeed and just delays the
      // token gate appearing by several seconds. Skip retries for any 4xx
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
 
ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <TokenGate>
        <App />
      </TokenGate>
    </QueryClientProvider>
  </React.StrictMode>,
);
