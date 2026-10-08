'use client';

import { useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';
import { useToast } from '@/components/toast';

/** Which cached queries become stale when a realtime event arrives. */
const INVALIDATES: Record<string, string[]> = {
  'build.updated': ['builds', 'build', 'overview', 'home'],
  'preview.updated': ['previews', 'build', 'overview', 'home'],
  timeline: ['timeline', 'overview'],
  'project.updated': ['project', 'projects', 'overview', 'manifest', 'home'],
  'repository.updated': ['repo', 'project', 'overview'],
  'feedback.updated': ['feedback', 'feedbackItem', 'overview', 'home', 'reviews'],
  'review.updated': ['reviews', 'review'],
  'review.message': ['reviewMessages'],
  'ai.task.updated': ['aiTasks', 'aiTask', 'home'],
  'deployment.updated': ['deployments', 'deployment', 'environments', 'versions', 'overview', 'home'],
  'security.scan': ['security', 'overview', 'securityCenter', 'project'],
  'responsive.updated': ['responsiveTests', 'responsiveTest'],
  'environment.updated': ['environments'],
  'incident.updated': ['incidents', 'incident'],
  'backup.updated': ['backups'],
  'task.updated': ['tasks', 'home'],
};

/** One EventSource per tab; reconnects automatically (SSE retry). */
export function RealtimeBridge() {
  const qc = useQueryClient();
  const toast = useToast();
  useEffect(() => {
    const es = new EventSource('/api/v1/stream');
    const pending = new Set<string>();
    let timer: ReturnType<typeof setTimeout> | null = null;
    const flush = () => {
      for (const key of pending) void qc.invalidateQueries({ queryKey: [key] });
      pending.clear();
      timer = null;
    };
    es.addEventListener('event', (msg) => {
      const e = JSON.parse((msg as MessageEvent).data) as { type: string };
      for (const k of INVALIDATES[e.type] ?? []) pending.add(k);
      // Coalesce bursts (a build emits many step updates per second).
      if (!timer) timer = setTimeout(flush, 250);
    });
    es.addEventListener('notification', (msg) => {
      const d = JSON.parse((msg as MessageEvent).data) as { title?: string };
      if (d.title) toast(d.title);
      void qc.invalidateQueries({ queryKey: ['notifications'] });
    });
    return () => {
      es.close();
      if (timer) clearTimeout(timer);
    };
  }, [qc, toast]);
  return null;
}
