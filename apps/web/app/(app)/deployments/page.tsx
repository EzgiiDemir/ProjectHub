'use client';

import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { api } from '@/lib/api';
import { ago, duration } from '@/lib/format';
import { ADAPTER, ENV_TYPE } from '@/lib/labels';
import type { Deployment } from '@/lib/types';
import { Async, Empty, Kpi, PageHeader, Panel, StatusBadge } from '@/components/ui';

const FILTERS: [string, string][] = [
  ['all', 'Tümü'],
  ['pending_approval', 'Onay bekleyen'],
  ['active', 'Sürenler'],
  ['failed', 'Başarısız / geri alınan'],
  ['production', 'Production'],
];

/** Organization-wide deployment center (spec §90): every release, its approvals and outcomes in one place. */
export default function DeploymentCenterPage() {
  const router = useRouter();
  const [filter, setFilter] = useState('all');
  const q = useQuery({ queryKey: ['deployments', 'all'], queryFn: () => api<Deployment[]>('/deployments'), refetchInterval: 15_000 });
  return (
    <div className="page">
      <PageHeader title="Deployment merkezi" sub="Tüm projelerin yayınları, onay bekleyenler ve sonuçları." />
      <Async q={q} rows={6}>
        {(all) => {
          const week = all.filter((d) => Date.now() - new Date(d.createdAt).getTime() < 7 * 86400_000);
          const finished = week.filter((d) => ['succeeded', 'failed', 'rolled_back'].includes(d.status));
          const rate = finished.length ? Math.round((finished.filter((d) => d.status === 'succeeded').length / finished.length) * 100) : null;
          const rows = all.filter((d) =>
            filter === 'all'
              ? true
              : filter === 'active'
                ? ['queued', 'running'].includes(d.status)
                : filter === 'failed'
                  ? ['failed', 'rolled_back'].includes(d.status)
                  : filter === 'production'
                    ? d.environmentType === 'production'
                    : d.status === filter,
          );
          return (
            <>
              <div className="grid g4" style={{ marginBottom: 14 }}>
                <Kpi value={all.filter((d) => d.status === 'pending_approval').length} label="Onay bekleyen" tone={all.some((d) => d.status === 'pending_approval') ? 'amber' : undefined} />
                <Kpi value={all.filter((d) => ['queued', 'running'].includes(d.status)).length} label="Süren" tone="run" />
                <Kpi value={week.length} label="Son 7 gün" />
                <Kpi value={rate === null ? '—' : `%${rate}`} label="7 günlük başarı" tone={rate === null ? undefined : rate >= 90 ? 'ok' : rate >= 70 ? 'warn' : 'bad'} />
              </div>
              <div className="row" style={{ marginBottom: 10 }}>
                {FILTERS.map(([k, l]) => (
                  <button key={k} className={`chip ${filter === k ? 'on' : ''}`} onClick={() => setFilter(k)}>
                    {l}
                  </button>
                ))}
              </div>
              {rows.length ? (
                <Panel flush>
                  <div className="tbl">
                    <table>
                      <thead>
                        <tr>
                          <th>No</th>
                          <th>Proje</th>
                          <th>Ortam</th>
                          <th>Versiyon</th>
                          <th>Durum</th>
                          <th>Yöntem</th>
                          <th>İsteyen</th>
                          <th>Süre</th>
                          <th>Zaman</th>
                        </tr>
                      </thead>
                      <tbody>
                        {rows.map((d) => (
                          <tr key={d.id} className="click" onClick={() => router.push(`/projects/${d.projectSlug}/deployments/${d.id}`)}>
                            <td className="mono small">{d.key}</td>
                            <td>
                              <Link href={`/projects/${d.projectSlug}`} onClick={(e) => e.stopPropagation()}>
                                {d.projectName}
                              </Link>
                            </td>
                            <td>
                              {d.environmentName} <span className="small muted">{ENV_TYPE[d.environmentType ?? ''] ?? ''}</span>
                            </td>
                            <td>
                              <span className="tag">v{d.version}</span> {d.isRollback && <span className="small muted">geri alma</span>}
                            </td>
                            <td>
                              <StatusBadge status={d.status} />
                            </td>
                            <td className="small">{d.adapter ? ADAPTER[d.adapter] : '—'}</td>
                            <td className="small">{d.requestedByName ?? 'sistem'}</td>
                            <td className="mono small">{d.startedAt && d.finishedAt ? duration(new Date(d.finishedAt).getTime() - new Date(d.startedAt).getTime()) : '—'}</td>
                            <td className="small muted">{ago(d.createdAt)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </Panel>
              ) : (
                <Empty title="Bu filtrede deployment yok" />
              )}
            </>
          );
        }}
      </Async>
    </div>
  );
}
