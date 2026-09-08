import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { apiClient } from "./client";
import type { BankHoliday, Closure, ClosureIn } from "./types";

export const closureKeys = {
  all: ["closures"] as const,
  list: (year: number | null) => [...closureKeys.all, "list", year] as const,
  bankHolidays: (year: number) => [...closureKeys.all, "bank-holidays", year] as const,
};

/**
 * Ad-hoc closures, either for one calendar year - the year shared by the
 * Session Management tabs, see SessionManagementTabs.tsx - or, with
 * year=null, unfiltered. The rota and duty grids pass null: they render
 * whatever period their rota covers, which need not be the selected year
 * and can straddle two of them.
 *
 * The fixed named bank holidays (Christmas Day etc.) are a separate list,
 * see useBankHolidays().
 */
export function useClosures(year: number | null) {
  return useQuery({
    queryKey: closureKeys.list(year),
    queryFn: () =>
      apiClient.get<Closure[]>(
        year === null ? "/closures" : `/closures?from_date=${year}-01-01&to_date=${year}-12-31`,
      ),
  });
}

export function useCreateClosure() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (payload: ClosureIn) => apiClient.post<Closure>("/closures", payload),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: closureKeys.all });
    },
  });
}

export function useDeleteClosure() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: number) => apiClient.delete<void>(`/closures/${id}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: closureKeys.all });
    },
  });
}

export function useBankHolidays(year: number) {
  return useQuery({
    queryKey: closureKeys.bankHolidays(year),
    queryFn: () => apiClient.get<BankHoliday[]>(`/closures/bank-holidays?year=${year}`),
  });
}

export function useSetBankHoliday(year: number) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ key, date }: { key: string; date: string | null }) =>
      apiClient.put<BankHoliday>(`/closures/bank-holidays/${key}?year=${year}`, { date }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: closureKeys.all });
    },
  });
}