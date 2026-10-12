'use client';

import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { api } from '@/lib/api';
import { ago, bytes, shortSha } from '@/lib/format';
import { useProjectSlug } from '@/lib/hooks';
import { ENV_TYPE, EVENT_KIND } from '@/lib/labels';
import type { Build, Environment, HealthInfo, ProjectDetail, ProjectEvent, TechDebt } from '@/lib/types';
import { Async, CopyButton, Empty, KeyValue, Kpi, Panel, ScoreBar, scoreColor, StatusBadge } from '@/components/ui';

interface Overview {
  project: ProjectDetail;
  lastBuild: Build | null;
  buildSuccessRate: number | null;
  openFeedback: number;
  runningPreviews: number;
  security: { score: number | null; summary: { critical: number; high: number; medium: number; low: number } | null; scannedAt: string | null } | null;
  environments: (Environment & { currentVersion: string | null })[];
  recentDeployments: { id: string; number: number; status: string; environmentName: string; version: string; createdAt: string }[];
  openIncidents: number;
  health: HealthInfo | null;
  techDebt: TechDebt | null;
  events: ProjectEvent[];
}

const COMPONENT_LABEL: Record<string, string> = { security: 'Güvenlik', build: 'Build başarısı', tests: 'Testler', dependencies: 'Bağımlılıklar', documentation: 'Dokümantasyon', deployment: 'Deployment', incidents: 'Olaylar' };

export default function OverviewPage() {
  const slug = useProjectSlug();
  const q = useQuery({ queryKey: ['overview', slug], queryFn: () => api<Overview>(`/projects/${slug}/overview`) });
  const base = `/projects/${slug}`;
  return (
    <Async q={q} rows={6}>
      {(o) => {
        const p = o.project;
        const stages: [string, string, boolean][] = [
          ['Proje', '', true],
          ['Kaynak kod', 'code', p.repository?.status === 'ready'],
          ['Build', 'builds', o.lastBuild?.status === 'passed' || (o.buildSuccessRate ?? 0) > 0],
          ['Ön izleme', 'previews', o.runningPreviews > 0],
          ['Kullanıcı', 'reviews', o.openFeedback > 0],
          ['Versiyon', 'versions', o.environments.some((e) => e.currentVersion)],
          ['Deployment', 'deployments', o.recentDeployments.some((d) => d.status === 'succeeded')],
          ['Güvenlik', 'security', !!o.security],
          ['AI', 'ai', false],
        ];
        const nowIdx = stages.findIndex((s) => !s[2]);
        return (
          <>
            <div className="rail" aria-label="Proje yaşam döngüsü">
              {stages.map(([label, key, done], i) => (
                <Link key={label} className={`st ${done ? 'done' : i === nowIdx ? 'now' : ''}`} href={key ? `${base}/${key}` : base}>
                  <i />
                  {label}
                </Link>
              ))}
            </div>
            <div className="grid g6" style={{ marginBottom: 14 }}>
              <Kpi value={p.healthScore ?? '—'} color={scoreColor(p.healthScore)} label="Proje sağlığı" />
              <Kpi value={o.lastBuild ? <StatusBadge status={o.lastBuild.status} /> : '—'} label={o.lastBuild ? `Son build #${o.lastBuild.number}` : 'Son build'} href={o.lastBuild ? `${base}/builds/${o.lastBuild.id}` : `${base}/builds`} />
              <Kpi value={o.runningPreviews} label="Çalışan ön izleme" href={`${base}/previews`} />
              <Kpi value={p.securityScore ?? '—'} color={scoreColor(p.securityScore)} label="Güvenlik skoru" href={`${base}/security`} />
              <Kpi value={o.openFeedback} label="Açık geri bildirim" href={`${base}/feedback`} tone={o.openFeedback ? 'amber' : undefined} />
              <Kpi value={o.openIncidents} label="Açık olay" href={`${base}/incidents`} tone={o.openIncidents ? 'bad' : undefined} />
            </div>
            <div className="grid split" style={{ marginBottom: 14 }}>
              <Panel title="Ortamlar" actions={<Link className="btn sm ghost" href={`${base}/environments`}>Yönet</Link>} flush>
                {o.environments.length ? (
                  o.environments.map((e) => (
                    <div key={e.id} className="list-item">
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <b>{e.name}</b> <span className="small muted">{ENV_TYPE[e.type]}</span>
                        <div className="small muted mono ellipsis">{e.url || 'adres tanımlı değil'}</div>
                      </div>
                      {e.currentVersion ? <span className="tag">v{e.currentVersion}</span> : <span className="small muted">yayın yok</span>}
                      <StatusBadge status={e.status} />
                    </div>
                  ))
                ) : (
                  <Empty title="Ortam tanımlı değil" />
                )}
              </Panel>
              <Panel title="Sağlık kırılımı">
                {o.health ? (
                  <>
                    {Object.entries(o.health.components).map(([k, v]) => (
                      <ScoreBar key={k} label={COMPONENT_LABEL[k] ?? k} value={v} />
                    ))}
                    <p className="small muted" style={{ margin: '8px 0 0' }}>Skor kesin ölçüm değil, yönetim sinyalidir. Son hesaplama {ago(o.health.computedAt)}.</p>
                  </>
                ) : (
                  <p className="muted small">Sağlık skoru ilk kod indekslemesi ve güvenlik taramasından sonra hesaplanır.</p>
                )}
              </Panel>
            </div>
            <div className="grid g3">
              <Panel title="Son etkinlik" actions={<Link className="btn sm ghost" href={`${base}/timeline`}>Zaman akışı</Link>}>
                {o.events.length ? (
                  o.events.map((e) => (
                    <div key={e.id} className="row" style={{ gap: 8, padding: '5px 0', flexWrap: 'nowrap', alignItems: 'flex-start' }}>
                      <span className="mono small muted" style={{ minWidth: 64 }}>{ago(e.createdAt)}</span>
                      <div style={{ minWidth: 0 }}>
                        <div style={{ fontSize: 13 }}>{e.title}</div>
                        <div className="small" style={{ color: EVENT_KIND[e.kind]?.[1] }}>{EVENT_KIND[e.kind]?.[0] ?? e.kind}</div>
                      </div>
                    </div>
                  ))
                ) : (
                  <p className="muted small">Henüz etkinlik yok.</p>
                )}
              </Panel>
              <Panel title="Teknik borç">
                {o.techDebt ? (
                  <>
                    <div style={{ marginBottom: 10 }}>
                      <StatusBadge status={o.techDebt.level === 'high' ? 'high' : o.techDebt.level === 'medium' ? 'medium' : 'low'} label={o.techDebt.level === 'high' ? 'Yüksek' : o.techDebt.level === 'medium' ? 'Orta' : 'Düşük'} />
                    </div>
                    <KeyValue
                      items={[
                        ['TODO / FIXME', o.techDebt.todo],
                        ['Uzun fonksiyon (>80 satır)', o.techDebt.longFunctions],
                        ['Büyük dosya (>500 satır)', o.techDebt.largeFiles],
                        ['Test dosyası', o.techDebt.testFiles],
                        ['Kaynak dosya', o.techDebt.sourceFiles],
                        ['README', o.techDebt.hasReadme ? 'var' : 'yok'],
                      ]}
                    />
                  </>
                ) : (
                  <p className="muted small">Kod indekslendiğinde hesaplanır.</p>
                )}
              </Panel>
              <Panel title="Proje bilgisi">
                <KeyValue
                  items={[
                    ['Kaynak', p.sourceLabel],
                    ['Tür', p.projectType || '—'],
                    ['Teknoloji', p.technologies.join(', ') || '—'],
                    ['Sahip', p.owner?.displayName ?? '—'],
                    ['Ekip', p.team?.name ?? '—'],
                    ['Repository', p.repository ? `${bytes(p.repository.sizeBytes)} · ${shortSha(p.repository.headCommit)}` : '—'],
                    [
                      'Git ile klonla',
                      p.repository ? (
                        <span className="row" style={{ gap: 6 }}>
                          <code className="small ellipsis" style={{ maxWidth: 180 }}>{p.repository.cloneUrl}</code>
                          <CopyButton text={`git clone ${p.repository.cloneUrl}`} />
                        </span>
                      ) : (
                        '—'
                      ),
                    ],
                    ['Manifest', <Link key="m" href={`${base}/settings?tab=manifest`}>projecthub.yml</Link>],
                  ]}
                />
                {!!p.detection?.warnings.length && (
                  <div className="warnbox" style={{ marginTop: 12 }}>
                    {p.detection.warnings.map((w) => (
                      <div key={w}>• {w}</div>
                    ))}
                  </div>
                )}
              </Panel>
            </div>
          </>
        );
      }}
    </Async>
  );
}
