import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { apiClient } from "./client";
import type { BankHoliday, Closure, ClosureIn } from "./types";

export const closureKeys = {
  all: ["closures"] as const,
  list: () => [...closureKeys.all, "list"] as const,
  bankHolidays: (year: number) => [...closureKeys.all, "bank-holidays", year] as const,
};

/**
 * Unfiltered, mirroring useDuty(): volume is a handful of ad-hoc dates per
 * year (M5 plan, Task 2), so there's no need for a date-range query param
 * on the frontend even though the backend supports one. The fixed named
 * bank holidays (Christmas Day etc.) are a separate list, see
 * useBankHolidays().
 */
export function useClosures() {
  return useQuery({
    queryKey: closureKeys.list(),
    queryFn: () => apiClient.get<Closure[]>("/closures"),
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