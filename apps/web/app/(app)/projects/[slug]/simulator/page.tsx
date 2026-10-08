'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ExternalLink, RefreshCw, RotateCw } from 'lucide-react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useEffect, useMemo, useRef, useState } from 'react';
import { api, errorMessage } from '@/lib/api';
import { ago, time } from '@/lib/format';
import { useProject, useProjectSlug } from '@/lib/hooks';
import { openPreview, previewAccessUrl } from '@/lib/preview';
import type { DeviceProfile, Preview, ResponsiveTest } from '@/lib/types';
import { DeviceFrame, useBridge, type BridgeMessage } from '@/components/device-frame';
import { Async, Badge, Drawer, Empty, ErrorState, Field, Loading, Panel, Segmented, StatusBadge } from '@/components/ui';
import { useToast } from '@/components/toast';

const CATEGORY: [DeviceProfile['category'], string][] = [
  ['phone', 'Telefon'],
  ['tablet', 'Tablet'],
  ['desktop', 'Masaüstü'],
];
const ISSUE: Record<string, string> = {
  horizontal_overflow: 'Yatay taşma',
  console_error: 'Konsol hatası',
  failed_request: 'Başarısız istek',
  page_error: 'Sayfa hatası',
  load_failed: 'Yüklenemedi',
  offscreen_cta: 'Görünmeyen buton',
};

type LogLine = { kind: 'console' | 'network'; level: string; text: string; at: number };

/** Device simulator (spec §44–53): the running preview in real viewport sizes, with console/network from the bridge. */
export default function SimulatorPage() {
  const slug = useProjectSlug();
  const params = useSearchParams();
  const router = useRouter();
  const toast = useToast();
  const project = useProject().data;
  const previews = useQuery({ queryKey: ['previews', slug], queryFn: () => api<Preview[]>(`/projects/${slug}/previews`) });
  const devices = useQuery({ queryKey: ['devices'], queryFn: () => api<DeviceProfile[]>('/device-profiles'), staleTime: Infinity });
  const ready = (previews.data ?? []).filter((p) => p.status === 'ready');
  const previewId = params.get('preview') ?? ready[0]?.id ?? null;
  const preview = ready.find((p) => p.id === previewId) ?? null;
  const [deviceKey, setDeviceKey] = useState<string | null>(null);
  const [landscape, setLandscape] = useState(false);
  const [src, setSrc] = useState<string | null>(null);
  const [path, setPath] = useState('/');
  const [pathInput, setPathInput] = useState('/');
  const [log, setLog] = useState<LogLine[]>([]);
  const [testOpen, setTestOpen] = useState<string | null>(null);
  const frame = useRef<HTMLIFrameElement>(null);
  const device = devices.data?.find((d) => d.key === deviceKey) ?? devices.data?.find((d) => d.isDefault && d.category === 'phone') ?? devices.data?.[0];
  const origin = useMemo(() => (preview ? new URL(preview.url).origin : null), [preview]);

  // A fresh signed URL per preview; navigation inside the frame keeps the preview cookie.
  useEffect(() => {
    setSrc(null);
    setLog([]);
    if (!preview) return;
    let cancelled = false;
    previewAccessUrl(preview.id, '/')
      .then((u) => !cancelled && setSrc(u))
      .catch((e) => toast(errorMessage(e), 'bad'));
    return () => {
      cancelled = true;
    };
  }, [preview, toast]);

  const send = useBridge(frame, origin, (m: BridgeMessage) => {
    if (m.type === 'nav') {
      setPath(m.path);
      setPathInput(m.path);
    } else if (m.type === 'console') setLog((l) => [...l.slice(-199), { kind: 'console', level: m.level, text: m.message, at: m.at }]);
    else if (m.type === 'network' && (m.status === 0 || m.status >= 400)) setLog((l) => [...l.slice(-199), { kind: 'network', level: 'error', text: `${m.method} ${m.url} → ${m.status || m.error} (${m.ms} ms)`, at: Date.now() }]);
  });

  if (previews.isLoading || devices.isLoading) return <Loading rows={5} />;
  if (previews.error) return <ErrorState error={previews.error} onRetry={() => void previews.refetch()} />;
  if (!ready.length || !preview)
    return (
      <Empty title="Çalışan ön izleme yok" action={<Link className="btn pri" href={`/projects/${slug}/previews`}>Ön izlemelere git</Link>}>
        Simülatör, çalışan bir ön izlemeyi farklı cihaz boyutlarında gösterir.
      </Empty>
    );

  const errors = log.filter((l) => l.level === 'error').length;
  return (
    <>
      <div className="spread" style={{ marginBottom: 12 }}>
        <div>
          <h2 style={{ margin: 0 }}>Cihaz simülatörü</h2>
          <p className="sub">Gerçek cihaz testi yerine geçmez; tarayıcı motoru masaüstü Chromium&apos;dur. Ekran boyutu, kırılımlar ve hata tespiti içindir.</p>
        </div>
        <div className="row">
          <select className="in" style={{ width: 'auto' }} value={preview.id} onChange={(e) => router.replace(`/projects/${slug}/simulator?preview=${e.target.value}`)} aria-label="Ön izleme">
            {ready.map((p) => (
              <option key={p.id} value={p.id}>
                Build #{p.buildNumber} · {p.sourceBranch}
              </option>
            ))}
          </select>
        </div>
      </div>
      <div className="grid" style={{ gridTemplateColumns: '220px minmax(0, 1fr)', alignItems: 'start' }}>
        <Panel flush>
          <div className="dev-list" style={{ padding: 6 }}>
            {CATEGORY.map(([cat, label]) => (
              <div key={cat}>
                <div className="small muted" style={{ padding: '8px 10px 4px', fontWeight: 600 }}>
                  {label}
                </div>
                {devices.data
                  ?.filter((d) => d.category === cat)
                  .map((d) => (
                    <button key={d.key} className={device?.key === d.key ? 'on' : ''} onClick={() => setDeviceKey(d.key)}>
                      <span>{d.name}</span>
                      <span className="mono small muted">
                        {d.width}×{d.height}
                      </span>
                    </button>
                  ))}
              </div>
            ))}
          </div>
        </Panel>
        <div style={{ minWidth: 0 }}>
          <div className="row" style={{ marginBottom: 8, flexWrap: 'nowrap' }}>
            <form
              style={{ flex: 1, display: 'flex', gap: 6 }}
              onSubmit={(e) => {
                e.preventDefault();
                if (pathInput.startsWith('/')) send({ type: 'navigate', path: pathInput });
              }}
            >
              <input className="in mono" value={pathInput} onChange={(e) => setPathInput(e.target.value)} aria-label="Sayfa yolu" />
            </form>
            <button className="btn" title="Yenile" onClick={() => send({ type: 'reload' })}>
              <RefreshCw />
            </button>
            {device?.category !== 'desktop' && (
              <button className={`btn ${landscape ? 'pri' : ''}`} title="Yatay / dikey" onClick={() => setLandscape((v) => !v)}>
                <RotateCw />
              </button>
            )}
            <button className="btn" title="Yeni sekmede aç" onClick={() => openPreview(preview.id, path).catch((e) => toast(errorMessage(e), 'bad'))}>
              <ExternalLink />
            </button>
          </div>
          <div className="sim-stage">{device && <DeviceFrame device={device} landscape={landscape} src={src} frameRef={frame} title={`${preview.slug} ön izleme`} />}</div>
          <Panel
            title={
              <span className="row" style={{ gap: 6 }}>
                Konsol ve ağ {errors > 0 && <Badge tone="bad">{errors} hata</Badge>}
              </span>
            }
            actions={
              log.length > 0 && (
                <button className="btn sm ghost" onClick={() => setLog([])}>
                  Temizle
                </button>
              )
            }
            className="mt"
          >
            {log.length ? (
              <div className="mono small" style={{ maxHeight: 180, overflow: 'auto' }}>
                {log.map((l, i) => (
                  <div key={i} style={{ color: l.level === 'error' ? 'var(--bad)' : 'var(--warn)', padding: '2px 0' }}>
                    <span className="muted">{time(l.at)}</span> [{l.kind === 'network' ? 'ağ' : l.level}] {l.text}
                  </div>
                ))}
              </div>
            ) : (
              <p className="small muted" style={{ margin: 0 }}>Hata yok. Ön izlemedeki konsol hataları ve başarısız istekler burada görünür.</p>
            )}
          </Panel>
        </div>
      </div>
      <ResponsiveTests slug={slug} preview={preview} devices={devices.data ?? []} canRun={!!project?.permissions.includes('preview.create')} onOpen={setTestOpen} />
      {testOpen && <TestDrawer id={testOpen} onClose={() => setTestOpen(null)} />}
    </>
  );
}

function ResponsiveTests({ slug, preview, devices, canRun, onOpen }: { slug: string; preview: Preview; devices: DeviceProfile[]; canRun: boolean; onOpen: (id: string) => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [scope, setScope] = useState<'default' | 'all'>('default');
  const [paths, setPaths] = useState('/');
  const [baseline, setBaseline] = useState('');
  const tests = useQuery({
    queryKey: ['responsiveTests', slug],
    queryFn: () => api<ResponsiveTest[]>(`/projects/${slug}/responsive-tests`),
    refetchInterval: (q) => ((q.state.data ?? []).some((t) => t.status === 'queued' || t.status === 'running') ? 3000 : false),
  });
  const completed = (tests.data ?? []).filter((t) => t.status === 'completed');
  const run = useMutation({
    mutationFn: () =>
      api<ResponsiveTest>(`/projects/${slug}/responsive-tests`, {
        method: 'POST',
        body: {
          previewId: preview.id,
          deviceKeys: scope === 'all' ? devices.map((d) => d.key) : undefined,
          paths: paths
            .split(/[\s,]+/)
            .map((p) => p.trim())
            .filter((p) => p.startsWith('/'))
            .slice(0, 10),
          baselineTestId: baseline || undefined,
        },
      }),
    onSuccess: (t) => {
      toast('Test kuyruğa alındı');
      void qc.invalidateQueries({ queryKey: ['responsiveTests'] });
      onOpen(t.id);
    },
    onError: (e) => toast(errorMessage(e), 'bad'),
  });
  return (
    <Panel title="Tüm cihazlarda test" className="mt">
      {canRun && (
        <div className="grid g4" style={{ alignItems: 'end', marginBottom: 12 }}>
          <Field label="Cihazlar">
            <Segmented value={scope} onChange={setScope} items={[['default', 'Varsayılan set'], ['all', `Tümü (${devices.length})`]]} />
          </Field>
          <Field label="Sayfalar" id="rt-paths" hint="Boşlukla ayırın, en çok 10">
            <input id="rt-paths" className="in mono" value={paths} onChange={(e) => setPaths(e.target.value)} />
          </Field>
          <Field label="Görsel karşılaştırma" id="rt-base">
            <select id="rt-base" className="in" value={baseline} onChange={(e) => setBaseline(e.target.value)}>
              <option value="">Yok</option>
              {completed.map((t) => (
                <option key={t.id} value={t.id}>
                  Build #{t.buildNumber} · {ago(t.createdAt)}
                </option>
              ))}
            </select>
          </Field>
          <div className="field">
            <button className="btn pri" onClick={() => run.mutate()} disabled={run.isPending}>
              {run.isPending && <span className="spinner" />} Testi başlat
            </button>
          </div>
        </div>
      )}
      <Async q={tests} rows={2}>
        {(rows) =>
          rows.length ? (
            <div className="tbl">
              <table>
                <thead>
                  <tr>
                    <th>Zaman</th>
                    <th>Ön izleme</th>
                    <th>Sayfalar</th>
                    <th>Durum</th>
                    <th>Sonuç</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((t) => (
                    <tr key={t.id} className="click" onClick={() => onOpen(t.id)}>
                      <td className="small">{ago(t.createdAt)}</td>
                      <td className="small">Build #{t.buildNumber}</td>
                      <td className="mono small">{t.paths.join(' ')}</td>
                      <td>
                        <StatusBadge status={t.status} />
                      </td>
                      <td className="small">
                        {t.summary ? (
                          <span className="row" style={{ gap: 4 }}>
                            <Badge tone="ok" plain>{t.summary.passed} geçti</Badge>
                            {t.summary.warning > 0 && <Badge tone="warn" plain>{t.summary.warning} uyarı</Badge>}
                            {t.summary.failed > 0 && <Badge tone="bad" plain>{t.summary.failed} hata</Badge>}
                          </span>
                        ) : (
                          (t.error ?? '—')
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <p className="small muted" style={{ margin: 0 }}>
              Test, ön izlemeyi her cihaz boyutunda gerçek bir tarayıcıda açar; taşma, konsol hatası, başarısız istek ve görünmeyen butonları raporlar, ekran görüntüsü alır.
            </p>
          )
        }
      </Async>
    </Panel>
  );
}

function TestDrawer({ id, onClose }: { id: string; onClose: () => void }) {
  const q = useQuery({
    queryKey: ['responsiveTest', id],
    queryFn: () => api<ResponsiveTest>(`/responsive-tests/${id}`),
    refetchInterval: (query) => (query.state.data && ['queued', 'running'].includes(query.state.data.status) ? 2500 : false),
  });
  const [only, setOnly] = useState<'all' | 'issues'>('issues');
  return (
    <Drawer title="Cihaz testi sonucu" onClose={onClose} wide>
      <Async q={q}>
        {(t) => {
          const results = (t.results ?? []).filter((r) => only === 'all' || r.status !== 'passed');
          return (
            <>
              <div className="spread" style={{ marginBottom: 12 }}>
                <span className="row">
                  <StatusBadge status={t.status} />
                  {t.summary && (
                    <span className="small muted">
                      {t.summary.total} kontrol · {t.summary.passed} geçti · {t.summary.warning} uyarı · {t.summary.failed} hata
                    </span>
                  )}
                </span>
                <Segmented value={only} onChange={setOnly} items={[['issues', 'Sorunlular'], ['all', 'Tümü']]} />
              </div>
              {t.error && <div className="badbox">{t.error}</div>}
              {(t.status === 'queued' || t.status === 'running') && <Loading label="Cihazlar test ediliyor…" />}
              {!results.length && t.status === 'completed' && <Empty title="Sorun bulunmadı">Tüm cihaz ve sayfalarda kontroller geçti.</Empty>}
              <div className="grid g2">
                {results.map((r) => (
                  <div key={r.id} className="panel" style={{ padding: 12 }}>
                    <div className="spread">
                      <b style={{ fontSize: 13 }}>
                        {r.deviceName} <span className="mono small muted">{r.width}×{r.height}</span>
                      </b>
                      <StatusBadge status={r.status === 'warning' ? 'medium' : r.status} label={r.status === 'passed' ? 'Geçti' : r.status === 'warning' ? 'Uyarı' : 'Hata'} />
                    </div>
                    <div className="mono small muted">
                      {r.path}
                      {r.loadMs ? ` · ${r.loadMs} ms` : ''}
                      {r.diffRatio !== null ? ` · görsel fark %${(r.diffRatio * 100).toFixed(2)}` : ''}
                    </div>
                    {r.issues.map((i, k) => (
                      <div key={k} className="small" style={{ marginTop: 4 }}>
                        <b>{ISSUE[i.code] ?? i.code}:</b> {i.message}
                      </div>
                    ))}
                    <div className="row" style={{ marginTop: 8, alignItems: 'flex-start' }}>
                      {r.screenshotArtifactId && (
                        <a href={`/api/v1/artifacts/${r.screenshotArtifactId}/content`} target="_blank" rel="noreferrer" style={{ flex: 1 }}>
                          {/* eslint-disable-next-line @next/next/no-img-element */}
                          <img src={`/api/v1/artifacts/${r.screenshotArtifactId}/content`} alt={`${r.deviceName} ${r.path}`} style={{ width: '100%', maxHeight: 260, objectFit: 'cover', objectPosition: 'top', border: '1px solid var(--line)', borderRadius: 6 }} />
                        </a>
                      )}
                      {r.diffArtifactId && (
                        <a href={`/api/v1/artifacts/${r.diffArtifactId}/content`} target="_blank" rel="noreferrer" style={{ flex: 1 }}>
                          {/* eslint-disable-next-line @next/next/no-img-element */}
                          <img src={`/api/v1/artifacts/${r.diffArtifactId}/content`} alt="Görsel fark" style={{ width: '100%', maxHeight: 260, objectFit: 'cover', objectPosition: 'top', border: '1px solid var(--line)', borderRadius: 6 }} />
                        </a>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </>
          );
        }}
      </Async>
    </Drawer>
  );
}
