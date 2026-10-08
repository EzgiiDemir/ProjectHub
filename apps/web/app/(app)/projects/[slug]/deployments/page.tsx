'use client';

import { useQuery } from '@tanstack/react-query';
import { useRouter, useSearchParams } from 'next/navigation';
import { api } from '@/lib/api';
import { ago, duration } from '@/lib/format';
import { useProjectSlug } from '@/lib/hooks';
import { ADAPTER } from '@/lib/labels';
import type { Deployment, Environment } from '@/lib/types';
import { Async, Empty, Panel, StatusBadge } from '@/components/ui';

export default function DeploymentsPage() {
  const slug = useProjectSlug();
  const router = useRouter();
  const params = useSearchParams();
  const env = params.get('env') ?? '';
  const q = useQuery({ queryKey: ['deployments', slug], queryFn: () => api<(Deployment & { environmentId: string })[]>(`/projects/${slug}/deployments`) });
  const envs = useQuery({ queryKey: ['environments', slug], queryFn: () => api<Environment[]>(`/projects/${slug}/environments`) });
  return (
    <>
      <div className="spread" style={{ marginBottom: 12 }}>
        <div>
          <h2 style={{ margin: 0 }}>Deployment&apos;lar</h2>
          <p className="sub">Her deployment adım adım kaydedilir; başarısız sağlık kontrolünde önceki sürüme otomatik dönülür.</p>
        </div>
        <select className="in" style={{ width: 'auto' }} value={env} onChange={(e) => router.replace(`/projects/${slug}/deployments${e.target.value ? `?env=${e.target.value}` : ''}`)} aria-label="Ortam">
          <option value="">Tüm ortamlar</option>
          {envs.data?.map((e) => (
            <option key={e.id} value={e.id}>
              {e.name}
            </option>
          ))}
        </select>
      </div>
      <Async q={q} rows={5}>
        {(all) => {
          const rows = env ? all.filter((d) => d.environmentId === env) : all;
          return rows.length ? (
            <Panel flush>
              <div className="tbl">
                <table>
                  <thead>
                    <tr>
                      <th>No</th>
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
                      <tr key={d.id} className="click" onClick={() => router.push(`/projects/${slug}/deployments/${d.id}`)}>
                        <td className="mono small">{d.key}</td>
                        <td>{d.environmentName}</td>
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
            <Empty title="Deployment yok">Ortamlar ekranından bir versiyonu yayına alın.</Empty>
          );
        }}
      </Async>
    </>
  );
}
