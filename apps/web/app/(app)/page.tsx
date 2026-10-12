'use client';

import { useQuery } from '@tanstack/react-query';
import { Plus } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import type { ReactNode } from 'react';
import { api } from '@/lib/api';
import { ago } from '@/lib/format';
import { useMe } from '@/lib/hooks';
import { Async, Badge, Empty, Kpi, Panel, scoreColor, StatusBadge } from '@/components/ui';
import { BarChart, SplitBar } from '@/components/charts';
import { EVENT_KIND } from '@/lib/labels';

interface Home {
  kpis: { activeProjects: number; runningPreviews: number; failedBuilds24h: number; criticalFindings: number; openFeedback: number; activeReviews: number };
  attention: { kind: string; title: string; detail: string; link: string; tone: 'bad' | 'warn' | 'run' }[];
  projects: { id: string; name: string; slug: string; color: string; status: string; healthScore: number | null; securityScore: number | null; currentVersion: string | null; lastBuildStatus: string | null; productionStatus: string | null }[];
  recentDeployments: { id: string; key: string; status: string; createdAt: string; environment: string; version: string; projectSlug: string; projectName: string; by: string | null }[];
}

interface Sections {
  work: {
    myPullRequests: { number: number; title: string; slug: string; project: string }[];
    reviewRequests: { number: number; title: string; slug: string; project: string; author: string | null; createdAt: string }[];
    recentBuilds: { id: string; number: number; status: string; branch: string; slug: string; project: string; createdAt: string }[];
    recentAiTasks: { id: string; number: number; title: string; status: string; slug: string; project: string }[];
  } | null;
  management: {
    projectsAtRisk: { id: string; name: string; slug: string; reasons: string[] }[];
    upcomingReleases: { id: string; version: string; slug: string; project: string; createdAt: string; migrations: number; highRiskMigrations: number }[];
    customerReviews: { id: string; name: string; versionLabel: string; slug: string; project: string; expiresAt: string; lastAccessAt: string | null; openFeedback: number }[];
  } | null;
  security: {
    openCritical: number;
    projectsWithoutRecentScan: number;
    newSecrets: { id: string; number: number; title: string; filePath: string | null; slug: string; project: string }[];
    dependencyRisk: { slug: string; project: string; critical: number; high: number; total: number }[];
    exceptions: { id: string; number: number; title: string; status: string; severity: string; reason: string | null; by: string | null; slug: string; project: string }[];
    trend: { week: string; score: number; scans: number }[];
  } | null;
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
              <Kpi value={h.kpis.openFeedback} label="Açık kullanıcı geri bildirimi" />
              <Kpi value={h.kpis.activeReviews} label="Aktif kullanıcı linki" />
            </div>
            <Insights part="charts" />
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
            <Insights part="operations" />
            <RoleSections />
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

function Item({ href, title, detail, badge }: { href: string; title: string; detail?: string; badge?: ReactNode }) {
  return (
    <Link className="list-item" href={href}>
      <div style={{ minWidth: 0, flex: 1 }}>
        <b style={{ fontSize: 13 }}>{title}</b>
        {detail && <div className="small muted ellipsis">{detail}</div>}
      </div>
      {badge}
    </Link>
  );
}

function Sub({ children }: { children: ReactNode }) {
  return (
    <div className="small muted" style={{ padding: '10px 14px 2px', fontWeight: 600 }}>
      {children}
    </div>
  );
}

function None({ children }: { children: ReactNode }) {
  return (
    <div className="small muted" style={{ padding: '4px 14px 8px' }}>
      {children}
    </div>
  );
}

/** Role-based sections (spec §137–139): developer work, project management and security views. */
function RoleSections() {
  const q = useQuery({ queryKey: ['home-sections'], queryFn: () => api<Sections>('/home/sections') });
  const s = q.data;
  if (!s || (!s.work && !s.management && !s.security)) return null;
  const panels = [s.work, s.management, s.security].filter(Boolean).length;
  return (
    <div className={`grid ${panels === 3 ? 'g3' : panels === 2 ? 'g2' : ''}`} style={{ marginBottom: 14, alignItems: 'start' }}>
      {s.work && (
        <Panel title="Çalışmalarım" flush>
          <Sub>İncelemenizi bekleyen PR&apos;lar</Sub>
          {s.work.reviewRequests.length ? (
            s.work.reviewRequests.map((p) => <Item key={`${p.slug}-${p.number}`} href={`/projects/${p.slug}/pull-requests/${p.number}`} title={`#${p.number} ${p.title}`} detail={`${p.project} · ${p.author ?? '—'} · ${ago(p.createdAt)}`} />)
          ) : (
            <None>Bekleyen inceleme yok.</None>
          )}
          <Sub>Açık PR&apos;larım</Sub>
          {s.work.myPullRequests.length ? s.work.myPullRequests.map((p) => <Item key={`${p.slug}-${p.number}`} href={`/projects/${p.slug}/pull-requests/${p.number}`} title={`#${p.number} ${p.title}`} detail={p.project} />) : <None>Açık PR yok.</None>}
          {s.work.recentBuilds.length > 0 && <Sub>Son build&apos;lerim</Sub>}
          {s.work.recentBuilds.map((b) => (
            <Item key={b.id} href={`/projects/${b.slug}/builds/${b.id}`} title={`#${b.number} · ${b.branch}`} detail={`${b.project} · ${ago(b.createdAt)}`} badge={<StatusBadge status={b.status} />} />
          ))}
          {s.work.recentAiTasks.length > 0 && <Sub>AI görevlerim</Sub>}
          {s.work.recentAiTasks.map((t) => (
            <Item key={t.id} href={`/projects/${t.slug}/ai/tasks/${t.id}`} title={`AI-${t.number} ${t.title}`} detail={t.project} badge={<StatusBadge status={t.status} />} />
          ))}
        </Panel>
      )}
      {s.management && (
        <Panel title="Proje yönetimi" flush>
          <Sub>Risk altındaki projeler</Sub>
          {s.management.projectsAtRisk.length ? s.management.projectsAtRisk.map((p) => <Item key={p.id} href={`/projects/${p.slug}`} title={p.name} detail={p.reasons.join(' · ')} />) : <None>Risk altında proje yok.</None>}
          <Sub>Yaklaşan sürümler</Sub>
          {s.management.upcomingReleases.length ? (
            s.management.upcomingReleases.map((v) => (
              <Item
                key={v.id}
                href={`/projects/${v.slug}/versions`}
                title={`${v.project} v${v.version}`}
                detail={`${ago(v.createdAt)} oluşturuldu${v.migrations ? ` · ${v.migrations} migration${v.highRiskMigrations ? ` (${v.highRiskMigrations} yüksek riskli)` : ''}` : ''}`}
              />
            ))
          ) : (
            <None>Production&apos;a çıkmayı bekleyen sürüm yok.</None>
          )}
          <Sub>Kullanıcı incelemeleri</Sub>
          {s.management.customerReviews.length ? (
            s.management.customerReviews.map((r) => (
              <Item
                key={r.id}
                href={`/projects/${r.slug}/reviews`}
                title={`${r.project} · ${r.name}`}
                detail={r.lastAccessAt ? `Son ziyaret ${ago(r.lastAccessAt)}` : 'Henüz açılmadı'}
                badge={r.openFeedback ? <Badge tone="warn">{r.openFeedback} açık</Badge> : undefined}
              />
            ))
          ) : (
            <None>Aktif kullanıcı linki yok.</None>
          )}
        </Panel>
      )}
      {s.security && (
        <Panel title="Güvenlik" actions={<Link className="btn sm ghost" href="/security">Güvenlik merkezi</Link>} flush>
          <div className="small" style={{ padding: '10px 14px 0' }}>
            <b style={{ color: s.security.openCritical ? 'var(--bad)' : 'var(--ok)' }}>{s.security.openCritical}</b> açık kritik bulgu
            {s.security.projectsWithoutRecentScan > 0 && <span className="muted"> · {s.security.projectsWithoutRecentScan} proje 7 gündür taranmadı</span>}
            {s.security.trend.length > 1 && <span className="muted"> · skor trendi: {s.security.trend.map((t) => t.score).join(' → ')}</span>}
          </div>
          <Sub>Yeni tespit edilen secret&apos;lar (7 gün)</Sub>
          {s.security.newSecrets.length ? (
            s.security.newSecrets.map((f) => <Item key={f.id} href={`/projects/${f.slug}/security?finding=${f.id}`} title={`SEC-${f.number} ${f.title}`} detail={`${f.project}${f.filePath ? ` · ${f.filePath}` : ''}`} />)
          ) : (
            <None>Yeni secret yok.</None>
          )}
          <Sub>Bağımlılık riski</Sub>
          {s.security.dependencyRisk.length ? (
            s.security.dependencyRisk.map((d) => <Item key={d.slug} href={`/projects/${d.slug}/dependencies`} title={d.project} detail={`${d.total} zafiyet · ${d.critical} kritik · ${d.high} yüksek`} />)
          ) : (
            <None>Zafiyetli bağımlılık yok.</None>
          )}
          <Sub>Gözden geçirilecek istisnalar</Sub>
          {s.security.exceptions.length ? (
            s.security.exceptions.map((f) => (
              <Item key={f.id} href={`/projects/${f.slug}/security?finding=${f.id}`} title={`SEC-${f.number} ${f.title}`} detail={`${f.project} · ${f.by ?? '—'}: ${f.reason ?? 'gerekçe yok'}`} badge={<StatusBadge status={f.status} />} />
            ))
          ) : (
            <None>Kabul edilmiş risk yok.</None>
          )}
        </Panel>
      )}
    </div>
  );
}

interface InsightsData {
  series: {
    days: string[];
    builds: { passed: number[]; failed: number[]; other: number[] };
    deployments: { succeeded: number[]; failed: number[]; other: number[] };
    commits: number[];
    feedbackOpened: number[];
    feedbackResolved: number[];
  };
  delivery: { builds: number; buildSuccessRate: number | null; averageBuildMs: number | null; deployments: number; deploymentSuccessRate: number | null; productionReleases: number } | null;
  environments: Record<string, number>;
  tasks: Record<string, number>;
  contributors: { name: string; events: number; commits: number; builds: number; deploys: number }[];
  activity: { id: string; kind: string; tone: string; title: string; description: string; actor: string; at: string; slug: string; project: string; color: string }[];
  security: { averageScore: number | null; open: Record<string, number> };
}

const duration = (ms: number | null) => (ms === null ? '—' : ms < 60_000 ? `${Math.round(ms / 1000)} sn` : `${(ms / 60_000).toFixed(1)} dk`);
const sum = (a: number[]) => a.reduce((x, y) => x + y, 0);

/** Dashboard charts and operational overview computed from real project data (GET /home/insights). */
function Insights({ part }: { part: 'charts' | 'operations' }) {
  const q = useQuery({ queryKey: ['home-insights'], queryFn: () => api<InsightsData>('/home/insights'), refetchInterval: 60_000 });
  const d = q.data;
  if (!d) return null;
  if (part === 'charts') {
    const s = d.series;
    return (
      <>
        <div className="grid g4" style={{ marginBottom: 14, alignItems: 'stretch' }}>
          <Panel title="Build'ler · 14 gün">
            <BarChart
              days={s.days}
              series={[
                { label: 'Başarılı', color: 'var(--ok)', values: s.builds.passed },
                { label: 'Başarısız', color: 'var(--bad)', values: s.builds.failed },
                { label: 'Diğer', color: 'var(--idle)', values: s.builds.other },
              ]}
            />
          </Panel>
          <Panel title="Deployment'lar · 14 gün">
            <BarChart
              days={s.days}
              series={[
                { label: 'Tamamlandı', color: 'var(--ok)', values: s.deployments.succeeded },
                { label: 'Başarısız / geri alındı', color: 'var(--bad)', values: s.deployments.failed },
                { label: 'Diğer', color: 'var(--idle)', values: s.deployments.other },
              ]}
            />
          </Panel>
          <Panel title="Commit'ler · 14 gün">
            <BarChart days={s.days} series={[{ label: 'Commit', color: 'var(--primary)', values: s.commits }]} />
          </Panel>
          <Panel title="Geri bildirim · 14 gün">
            <BarChart
              days={s.days}
              series={[
                { label: 'Gelen', color: 'var(--amber)', values: s.feedbackOpened },
                { label: 'Çözülen', color: 'var(--ok)', values: s.feedbackResolved },
              ]}
            />
          </Panel>
        </div>
        {d.delivery && (
          <div className="stat-strip" style={{ marginBottom: 14 }}>
            <div>
              <div className="v" style={{ color: d.delivery.buildSuccessRate === null ? undefined : scoreColor(d.delivery.buildSuccessRate) }}>{d.delivery.buildSuccessRate === null ? '—' : `%${d.delivery.buildSuccessRate}`}</div>
              <div className="l">Build başarı oranı · {d.delivery.builds} build (30 gün)</div>
            </div>
            <div>
              <div className="v">{duration(d.delivery.averageBuildMs)}</div>
              <div className="l">Ortalama başarılı build süresi</div>
            </div>
            <div>
              <div className="v">{d.delivery.productionReleases}</div>
              <div className="l">Production yayını (30 gün)</div>
            </div>
            <div>
              <div className="v" style={{ color: d.delivery.deploymentSuccessRate === null ? undefined : scoreColor(d.delivery.deploymentSuccessRate) }}>{d.delivery.deploymentSuccessRate === null ? '—' : `%${d.delivery.deploymentSuccessRate}`}</div>
              <div className="l">Deployment başarı oranı · {d.delivery.deployments} deployment</div>
            </div>
            <div>
              <div className="v" style={{ color: scoreColor(d.security.averageScore) }}>{d.security.averageScore ?? '—'}</div>
              <div className="l">Ortalama güvenlik skoru</div>
            </div>
          </div>
        )}
      </>
    );
  }
  const e = d.environments;
  const t = d.tasks;
  const o = d.security.open;
  return (
    <div className="grid g3" style={{ marginBottom: 14, alignItems: 'start' }}>
      <Panel title="Son etkinlikler" actions={<span className="small muted">{sum(d.series.commits)} commit · 14 gün</span>} flush>
        {d.activity.length ? (
          d.activity.map((a) => (
            <Link key={a.id} className="feed-item" href={`/projects/${a.slug}/timeline`} style={{ color: 'inherit', textDecoration: 'none' }}>
              <span className="dot" style={{ background: EVENT_KIND[a.kind]?.[1] ?? 'var(--idle)' }} />
              <div style={{ minWidth: 0 }}>
                <div style={{ fontSize: 13.5, fontWeight: 600 }} className="ellipsis">
                  {a.title}
                </div>
                <div className="small muted ellipsis">
                  {a.project} · {a.actor} · {ago(a.at)}
                </div>
              </div>
            </Link>
          ))
        ) : (
          <Empty title="Henüz etkinlik yok" />
        )}
      </Panel>
      <div style={{ display: 'grid', gap: 14 }}>
        <Panel title="Production ortamları">
          <SplitBar
            parts={[
              { label: 'Sağlıklı', value: e.healthy ?? 0, color: 'var(--ok)' },
              { label: 'Yavaş / sorunlu', value: e.degraded ?? 0, color: 'var(--warn)' },
              { label: 'Erişilemiyor', value: e.down ?? 0, color: 'var(--bad)' },
              { label: 'İzlenmiyor', value: e.unknown ?? 0, color: 'var(--idle)' },
            ]}
          />
        </Panel>
        <Panel title="Görev panosu" actions={<Link className="btn sm ghost" href="/team">Takım çalışması</Link>}>
          <SplitBar
            parts={[
              { label: 'Yapılacak', value: t.todo ?? 0, color: 'var(--idle)' },
              { label: 'Yapılıyor', value: t.in_progress ?? 0, color: 'var(--run)' },
              { label: 'İncelemede', value: t.in_review ?? 0, color: 'var(--amber)' },
              { label: 'Tamamlandı', value: t.done ?? 0, color: 'var(--ok)' },
            ]}
          />
        </Panel>
        <Panel title="Açık güvenlik bulguları" actions={<Link className="btn sm ghost" href="/security">Güvenlik merkezi</Link>}>
          <SplitBar
            parts={[
              { label: 'Kritik', value: o.critical ?? 0, color: 'var(--bad)' },
              { label: 'Yüksek', value: o.high ?? 0, color: '#d9480f' },
              { label: 'Orta', value: o.medium ?? 0, color: 'var(--warn)' },
              { label: 'Düşük', value: (o.low ?? 0) + (o.info ?? 0), color: 'var(--idle)' },
            ]}
          />
        </Panel>
      </div>
      <Panel title="En aktif ekip üyeleri · 30 gün" flush>
        {d.contributors.length ? (
          <div className="tbl">
            <table>
              <thead>
                <tr>
                  <th>Kişi</th>
                  <th>Commit</th>
                  <th>Build</th>
                  <th>Deploy</th>
                </tr>
              </thead>
              <tbody>
                {d.contributors.map((c) => (
                  <tr key={c.name}>
                    <td>
                      <b>{c.name}</b>
                      <div className="small muted">{c.events} işlem</div>
                    </td>
                    <td>{c.commits}</td>
                    <td>{c.builds}</td>
                    <td>{c.deploys}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <Empty title="Son 30 günde etkinlik yok" />
        )}
      </Panel>
    </div>
  );
}
