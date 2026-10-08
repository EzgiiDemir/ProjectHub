'use client';

import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useMemo, useState } from 'react';
import { api } from '@/lib/api';
import { ago } from '@/lib/format';
import { useMe } from '@/lib/hooks';
import type { ProjectSummary } from '@/lib/types';
import { Async, Avatar, Empty, PageHeader, scoreColor, StatusBadge } from './ui';

/** Project list (active) and central archive (everything, with year/technology filters — spec §92–93). */
export function ProjectTable({ archive }: { archive: boolean }) {
  const router = useRouter();
  const me = useMe().data;
  const [status, setStatus] = useState(archive ? 'all' : 'active');
  const [search, setSearch] = useState('');
  const [year, setYear] = useState('');
  const [tech, setTech] = useState('');
  const query = new URLSearchParams({ status: archive ? status : status === 'active' ? 'all' : status });
  if (search.trim()) query.set('search', search.trim());
  if (year) query.set('year', year);
  if (tech) query.set('technology', tech);
  const projects = useQuery({ queryKey: ['projects', query.toString()], queryFn: () => api<ProjectSummary[]>(`/projects?${query}`) });
  const all = useQuery({ queryKey: ['projects', 'sidebar'], queryFn: () => api<ProjectSummary[]>('/projects?status=all') });
  const facets = useMemo(() => {
    const ys = new Set<string>();
    const ts = new Set<string>();
    for (const p of all.data ?? []) {
      ys.add(String(new Date(p.createdAt).getFullYear()));
      p.technologies.forEach((t) => ts.add(t));
    }
    return { years: [...ys].sort().reverse(), techs: [...ts].sort() };
  }, [all.data]);
  const filters: [string, string][] = archive
    ? [['all', 'Tümü'], ['active', 'Aktif'], ['maintenance', 'Bakımda'], ['paused', 'Durduruldu'], ['archived', 'Arşivlendi']]
    : [['active', 'Aktif'], ['maintenance', 'Bakımda'], ['paused', 'Durduruldu']];

  return (
    <div className="page">
      <PageHeader
        title={archive ? 'Merkezi proje arşivi' : 'Projeler'}
        sub={archive ? 'Eski ve güncel tüm projeler. Arşivlenen projeler silinmez; kod, sürümler, dokümanlar ve denetim kayıtları korunur.' : 'Erişiminiz olan projeler.'}
        actions={me?.permissions.includes('project.create') && <Link className="btn pri" href="/projects/new">Proje ekle / içe aktar</Link>}
      />
      <div className="spread" style={{ marginBottom: 12 }}>
        <div className="row">
          {filters.map(([k, l]) => (
            <button key={k} className={`chip ${status === k ? 'on' : ''}`} onClick={() => setStatus(k)}>
              {l}
            </button>
          ))}
          {archive && (
            <>
              <select className="in" style={{ width: 'auto' }} value={year} onChange={(e) => setYear(e.target.value)} aria-label="Yıl">
                <option value="">Tüm yıllar</option>
                {facets.years.map((y) => (
                  <option key={y}>{y}</option>
                ))}
              </select>
              <select className="in" style={{ width: 'auto' }} value={tech} onChange={(e) => setTech(e.target.value)} aria-label="Teknoloji">
                <option value="">Tüm teknolojiler</option>
                {facets.techs.map((t) => (
                  <option key={t}>{t}</option>
                ))}
              </select>
            </>
          )}
        </div>
        <input className="in" style={{ maxWidth: 320 }} placeholder={archive ? 'Örn. Laravel ödeme, müşteri adı…' : 'Proje, müşteri veya teknoloji ara'} value={search} onChange={(e) => setSearch(e.target.value)} />
      </div>
      <div className="panel flush">
        <Async q={projects}>
          {(rows) => {
            const list = !archive && status === 'active' ? rows.filter((r) => r.status === 'active') : rows;
            return list.length ? (
              <div className="tbl">
                <table>
                  <thead>
                    <tr>
                      <th>Proje</th>
                      <th>Tür</th>
                      <th>Kaynak</th>
                      <th>Müşteri / birim</th>
                      <th>Sahip</th>
                      <th>Sürüm</th>
                      <th>Durum</th>
                      <th>Sağlık</th>
                      <th>Güncellendi</th>
                    </tr>
                  </thead>
                  <tbody>
                    {list.map((p) => (
                      <tr key={p.id} className="click" onClick={() => router.push(`/projects/${p.slug}`)}>
                        <td>
                          <div className="row" style={{ gap: 10, flexWrap: 'nowrap' }}>
                            <span className="p-logo" style={{ background: p.color, width: 30, height: 30, fontSize: 12, borderRadius: 7 }}>
                              {p.name.slice(0, 2).toUpperCase()}
                            </span>
                            <div>
                              <b>{p.name}</b>
                              <div className="small muted">{p.technologies.slice(0, 3).join(', ') || '—'}</div>
                            </div>
                          </div>
                        </td>
                        <td className="small">{p.projectType || '—'}</td>
                        <td className="small muted ellipsis" style={{ maxWidth: 220 }}>
                          {p.repositoryStatus === 'provisioning' ? <StatusBadge status="provisioning" /> : p.repositoryStatus === 'failed' ? <StatusBadge status="failed" label="Repository hatası" /> : p.sourceLabel}
                        </td>
                        <td className="small">{p.customerName || '—'}</td>
                        <td>{p.owner ? <Avatar name={p.owner.displayName} color={p.owner.avatarColor} size={24} /> : '—'}</td>
                        <td className="mono">{p.currentVersion ? `v${p.currentVersion}` : '—'}</td>
                        <td>
                          <StatusBadge status={p.status} />
                        </td>
                        <td>
                          <b style={{ color: scoreColor(p.healthScore) }}>{p.healthScore ?? '—'}</b>
                        </td>
                        <td className="small muted">{ago(p.updatedAt)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <Empty title="Eşleşen proje yok">Filtreyi temizleyin veya farklı bir ifade deneyin.</Empty>
            );
          }}
        </Async>
      </div>
    </div>
  );
}
