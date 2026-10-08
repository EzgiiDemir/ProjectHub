'use client';

import { useQuery } from '@tanstack/react-query';
import { useParams } from 'next/navigation';
import type { Permission } from '@projecthub/contracts';
import { api } from './api';
import type { DirectoryUser, Me, ProjectDetail } from './types';

export function useMe() {
  return useQuery({ queryKey: ['me'], queryFn: () => api<Me>('/auth/me'), staleTime: 60_000 });
}

/** Organization-level permission check (UI only — the API enforces everything again). */
export function useCan() {
  const me = useMe();
  return (p: Permission) => !!me.data?.permissions.includes(p);
}

export function useProjectSlug(): string {
  const params = useParams<{ slug: string }>();
  return params.slug;
}

export function useProject(slug?: string) {
  const routeSlug = useProjectSlug();
  const s = slug ?? routeSlug;
  return useQuery({ queryKey: ['project', s], queryFn: () => api<ProjectDetail>(`/projects/${s}`), staleTime: 15_000 });
}

/** Project-level permission check from the effective permissions the API returned for this project. */
export function useProjectCan(slug?: string) {
  const p = useProject(slug);
  return (perm: Permission) => !!p.data?.permissions.includes(perm);
}

export function useDirectory() {
  return useQuery({ queryKey: ['directory'], queryFn: () => api<DirectoryUser[]>('/admin/directory'), staleTime: 5 * 60_000 });
}
