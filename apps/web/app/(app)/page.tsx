'use client';

import { useQuery } from '@tanstack/react-query';
import { Plus } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { api } from '@/lib/api';
import { ago } from '@/lib/format';
import { useMe } from '@/lib/hooks';
import { Async, Badge, Empty, Kpi, Panel, scoreColor, StatusBadge } from '@/components/ui';

interface Home {
  kpis: { activeProjects: number; runningPreviews: number; failedBuilds24h: number; criticalFindings: number; openFeedback: number; activeReviews: number };
  attention: { kind: string; title: string; detail: string; link: string; tone: 'bad' | 'warn' | 'run' }[];
  projects: { id: string; name: string; slug: string; color: string; status: string; healthScore: number | null; securityScore: number | null; currentVersion: string | null; lastBuildStatus: string | null; productionStatus: string | null }[];
  recentDeployments: { id: string; key: string; status: string; createdAt: string; environment: string; version: string; projectSlug: string; projectName: string; by: string | null }[];
}

const KIND_LABEL: Record<string, string> = { feedback: 'Feedback', deployment: 'Onay', ai: 'AI', build: 'Build', security: 'Güvenlik', task: 'Görev' };

export default function HomePage() {
  const me = useMe().data;
  const router = useRouter();
  const home = useQuery({ queryKey: ['home'], queryFn: () => api<Home>('/home') });
  const hour = new Date().getHours();
  const greet = hour < 12 ? 'Günaydın' : hour < 18 ? 'İyi günler' : 'İyi akşamlar';

  return (
    <div className="page">
      <div className="spread" style={{ marginBottom: 18 }}>
        <div>
          <h1>
            {greet}, {me?.user.displayName.split(' ')[0]}
          </h1>
          <p className="sub" style={{ margin: '4px 0 0' }}>
            {new Intl.DateTimeFormat('tr-TR', { dateStyle: 'full' }).format(new Date())} · {me?.organization?.name}
          </p>
        </div>
        {me?.permissions.includes('project.create') && (
          <Link className="btn pri" href="/projects/new">
            <Plus /> Proje ekle
          </Link>
        )}
      </div>
      <Async q={home} rows={6}>
        {(h) => (
          <>
            <div className="grid g6" style={{ marginBottom: 14 }}>
              <Kpi value={h.kpis.activeProjects} label="Aktif proje" href="/projects" />
              <Kpi value={h.kpis.runningPreviews} label="Çalışan ön izleme" />
              <Kpi value={h.kpis.failedBuilds24h} label="Başarısız build (24 sa)" tone={h.kpis.failedBuilds24h ? 'bad' : undefined} />
              <Kpi value={h.kpis.criticalFindings} label="Kritik güvenlik bulgusu" href="/security" tone={h.kpis.criticalFindings ? 'bad' : undefined} />
              <Kpi value={h.kpis.openFeedback} label="Açık müşteri geri bildirimi" />
              <Kpi value={h.kpis.activeReviews} label="Aktif müşteri linki" />
            </div>
            <div className="grid split" style={{ marginBottom: 14 }}>
              <Panel title="Proje sağlığı" actions={<Link className="btn sm ghost" href="/projects">Tümü</Link>} flush>
                {h.projects.length ? (
                  <div className="tbl">
                    <table>
                      <thead>
                        <tr>
                          <th>Proje</th>
                          <th>Sağlık</th>
                          <th>Son build</th>
                          <th>Güvenlik</th>
                          <th>Production</th>
                          <th>Sürüm</th>
                        </tr>
                      </thead>
                      <tbody>
                        {h.projects.map((p) => (
                          <tr key={p.id} className="click" onClick={() => router.push(`/projects/${p.slug}`)}>
                            <td>
                              <div className="row" style={{ gap: 8, flexWrap: 'nowrap' }}>
                                <span className="p-logo" style={{ background: p.color, width: 26, height: 26, fontSize: 11, borderRadius: 6 }}>
                                  {p.name.slice(0, 2).toUpperCase()}
                                </span>
                                <b>{p.name}</b>
                              </div>
                            </td>
                            <td>
                              <b style={{ color: scoreColor(p.healthScore) }}>{p.healthScore ?? '—'}</b>
                            </td>
                            <td>{p.lastBuildStatus ? <StatusBadge status={p.lastBuildStatus} /> : <span className="muted small">—</span>}</td>
                            <td>
                              <span style={{ color: scoreColor(p.securityScore) }}>{p.securityScore ?? '—'}</span>
                            </td>
                            <td>{p.productionStatus ? <StatusBadge status={p.productionStatus} /> : <span className="muted small">—</span>}</td>
                            <td className="mono">{p.currentVersion ? `v${p.currentVersion}` : '—'}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                ) : (
                  <Empty title="Henüz proje yok" action={me?.permissions.includes('project.create') ? <Link className="btn pri" href="/projects/new">İlk projeyi ekle</Link> : undefined}>
                    Mevcut bir projeyi Git adresinden veya ZIP olarak içe aktarabilir ya da sıfırdan başlayabilirsiniz.
                  </Empty>
                )}
              </Panel>
              <Panel title="Sizi bekleyenler" flush>
                {h.attention.length ? (
                  h.attention.map((a, i) => (
                    <Link key={i} className="list-item" href={a.link}>
                      <Badge tone={a.tone} plain>
                        {KIND_LABEL[a.kind] ?? a.kind}
                      </Badge>
                      <div style={{ minWidth: 0 }}>
                        <b style={{ fontSize: 13 }}>{a.title}</b>
                        <div className="small muted ellipsis">{a.detail}</div>
                      </div>
                    </Link>
                  ))
                ) : (
                  <Empty title="Her şey yolunda">Onay, atanmış geri bildirim veya kritik bulgu yok.</Empty>
                )}
              </Panel>
            </div>
            <Panel title="Son deployment'lar" actions={<Link className="btn sm ghost" href="/deployments">Deployment merkezi</Link>} flush>
              {h.recentDeployments.length ? (
                h.recentDeployments.map((d) => (
                  <Link key={d.id} className="list-item" href={`/projects/${d.projectSlug}/deployments/${d.id}`}>
                    <span className="mono" style={{ minWidth: 48 }}>{d.key}</span>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <b>{d.projectName}</b> <span className="mono">v{d.version}</span> → {d.environment}
                      <div className="small muted">
                        {d.by ?? '—'} · {ago(d.createdAt)}
                      </div>
                    </div>
                    <StatusBadge status={d.status} />
                  </Link>
                ))
              ) : (
                <Empty title="Henüz deployment yapılmadı" />
              )}
            </Panel>
          </>
        )}
      </Async>
    </div>
  );
}
