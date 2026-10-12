'use client';

import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { useState } from 'react';
import { apiPaged, api } from '@/lib/api';
import { dateTime } from '@/lib/format';
import type { ProjectSummary } from '@/lib/types';
import { Drawer, Empty, ErrorState, Loading, PageHeader, Panel } from '@/components/ui';

interface AuditEvent {
  id: string;
  projectId: string | null;
  actorType: string;
  actorLabel: string;
  action: string;
  resourceType: string;
  resourceId: string | null;
  metadata: Record<string, unknown>;
  ipAddress: string | null;
  userAgent: string | null;
  createdAt: string;
  projectName: string | null;
  projectSlug: string | null;
}

const ACTOR: Record<string, string> = { user: 'Kullanıcı', ai: 'AI', system: 'Sistem', customer: 'Kullanıcı', agent: 'Ajan' };

/** Append-only audit log (spec §124–126): who did what, when, from where. Rows cannot be edited or deleted. */
export default function AuditPage() {
  const [filters, setFilters] = useState({ actorType: '', projectId: '', action: '', from: '', to: '' });
  const [applied, setApplied] = useState(filters);
  const [open, setOpen] = useState<AuditEvent | null>(null);
  const projects = useQuery({ queryKey: ['projects', 'sidebar'], queryFn: () => api<ProjectSummary[]>('/projects?status=all') });
  const qs = new URLSearchParams({ limit: '50' });
  if (applied.actorType) qs.set('actorType', applied.actorType);
  if (applied.projectId) qs.set('projectId', applied.projectId);
  if (applied.action.trim()) qs.set('action', applied.action.trim());
  if (applied.from) qs.set('from', new Date(`${applied.from}T00:00:00`).toISOString());
  if (applied.to) qs.set('to', new Date(`${applied.to}T23:59:59`).toISOString());
  const q = useInfiniteQuery({
    queryKey: ['audit', qs.toString()],
    queryFn: ({ pageParam }) => apiPaged<AuditEvent>(`/admin/audit?${qs}${pageParam ? `&cursor=${encodeURIComponent(pageParam)}` : ''}`),
    initialPageParam: '',
    getNextPageParam: (last) => (last.meta.hasMore ? (last.meta.nextCursor ?? undefined) : undefined),
  });
  const rows = q.data?.pages.flatMap((p) => p.data) ?? [];
  const set = (k: keyof typeof filters) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => setFilters((f) => ({ ...f, [k]: e.target.value }));

  return (
    <div className="page">
      <PageHeader title="Denetim kaydı" sub="Değiştirilemez kayıt: oturum açma, yetki değişiklikleri, deployment, secret erişimi, AI işlemleri ve kullanıcı hareketleri." />
      <form
        className="row"
        style={{ marginBottom: 12, alignItems: 'flex-end' }}
        onSubmit={(e) => {
          e.preventDefault();
          setApplied(filters);
        }}
      >
        <select className="in" style={{ width: 'auto' }} value={filters.actorType} onChange={set('actorType')} aria-label="Aktör">
          <option value="">Tüm aktörler</option>
          {Object.entries(ACTOR).map(([k, l]) => (
            <option key={k} value={k}>
              {l}
            </option>
          ))}
        </select>
        <select className="in" style={{ width: 'auto' }} value={filters.projectId} onChange={set('projectId')} aria-label="Proje">
          <option value="">Tüm projeler</option>
          {projects.data?.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
        <input className="in mono" style={{ width: 200 }} placeholder="işlem, ör. deployment" value={filters.action} onChange={set('action')} />
        <input className="in" type="date" style={{ width: 'auto' }} value={filters.from} onChange={set('from')} aria-label="Başlangıç" />
        <input className="in" type="date" style={{ width: 'auto' }} value={filters.to} onChange={set('to')} aria-label="Bitiş" />
        <button className="btn pri">Filtrele</button>
      </form>
      {q.isLoading && <Loading rows={8} />}
      {q.error && <ErrorState error={q.error} onRetry={() => void q.refetch()} />}
      {!q.isLoading && !rows.length && <Empty title="Kayıt yok" />}
      {rows.length > 0 && (
        <Panel flush>
          <div className="tbl">
            <table>
              <thead>
                <tr>
                  <th>Zaman</th>
                  <th>Aktör</th>
                  <th>İşlem</th>
                  <th>Kaynak</th>
                  <th>Proje</th>
                  <th>IP</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((e) => (
                  <tr key={e.id} className="click" onClick={() => setOpen(e)}>
                    <td className="small mono">{dateTime(e.createdAt)}</td>
                    <td className="small">
                      {e.actorLabel} <span className="muted">· {ACTOR[e.actorType] ?? e.actorType}</span>
                    </td>
                    <td className="mono small">{e.action}</td>
                    <td className="small muted">{e.resourceType}</td>
                    <td className="small">{e.projectSlug ? <Link href={`/projects/${e.projectSlug}`} onClick={(x) => x.stopPropagation()}>{e.projectName}</Link> : '—'}</td>
                    <td className="mono small muted">{e.ipAddress ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Panel>
      )}
      {q.hasNextPage && (
        <div style={{ textAlign: 'center', marginTop: 12 }}>
          <button className="btn" onClick={() => void q.fetchNextPage()} disabled={q.isFetchingNextPage}>
            Daha eski kayıtlar
          </button>
        </div>
      )}
      {open && (
        <Drawer title={<span className="mono">{open.action}</span>} onClose={() => setOpen(null)}>
          <dl className="kv">
            <dt>Zaman</dt>
            <dd>{dateTime(open.createdAt)}</dd>
            <dt>Aktör</dt>
            <dd>
              {open.actorLabel} ({ACTOR[open.actorType] ?? open.actorType})
            </dd>
            <dt>Kaynak</dt>
            <dd className="mono small">
              {open.resourceType}
              {open.resourceId ? ` · ${open.resourceId}` : ''}
            </dd>
            <dt>Proje</dt>
            <dd>{open.projectName ?? '—'}</dd>
            <dt>IP</dt>
            <dd className="mono small">{open.ipAddress ?? '—'}</dd>
            <dt>İstemci</dt>
            <dd className="small">{open.userAgent ?? '—'}</dd>
          </dl>
          <h3 style={{ margin: '16px 0 6px' }}>Ayrıntı</h3>
          <pre className="log" style={{ maxHeight: 400 }}>
            {JSON.stringify(open.metadata, null, 2)}
          </pre>
        </Drawer>
      )}
    </div>
  );
}
