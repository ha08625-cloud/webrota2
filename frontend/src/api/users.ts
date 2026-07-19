import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { apiClient } from "./client";
import type { AuthUser, UserIn, UserPatch } from "./types";

export const userKeys = {
  all: ["users"] as const,
  list: () => [...userKeys.all, "list"] as const,
};

/**
 * GET /users - unlike useDoctors, there is no active_only param: the
 * users router always returns every user regardless of status (auth
 * plan, Task 3), and UsersPage needs both active and inactive rows in
 * one list so a deactivated user can be found again and reactivated.
 */
export function useUsers() {
  return useQuery({
    queryKey: userKeys.list(),
    queryFn: () => apiClient.get<AuthUser[]>("/users"),
  });
}

export function useCreateUser() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (payload: UserIn) => apiClient.post<AuthUser>("/users", payload),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: userKeys.all });
    },
  });
}

export interface UpdateUserPayload {
  id: number;
  payload: UserPatch;
}

/**
 * PATCH /users/{id} - a single endpoint doing triple duty: editing
 * email/name, deactivating/reactivating (active alone), and resetting a
 * password (password alone, "leave blank to keep current" in
 * UserFormDialog). There is no separate reset-password route - see
 * routers/users.py.
 */
export function useUpdateUser() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, payload }: UpdateUserPayload) => apiClient.patch<AuthUser>(`/users/${id}`, payload),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: userKeys.all });
    },
  });
}