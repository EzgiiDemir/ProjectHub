'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Bot, Download, ScanSearch } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { api, errorMessage } from '@/lib/api';
import { ago, shortSha } from '@/lib/format';
import { useProject, useProjectSlug } from '@/lib/hooks';
import { Async, Drawer, Empty, Kpi, Panel, Segmented, StatusBadge } from '@/components/ui';
import { useToast } from '@/components/toast';

interface DependencyItem {
  ecosystem: string;
  name: string;
  version: string;
  latest: string | null;
  update: 'major' | 'minor' | 'patch' | null;
  risk: 'critical' | 'high' | 'medium' | 'low' | 'info' | 'none';
  direct: boolean;
  source: string;
  approximate: boolean;
  fixedVersion: string | null;
  vulnerabilities: { id: string; number: number; severity: string; title: string; advisoryId: string | null; fixedVersion: string | null }[];
}
interface DependencyList {
  scannedAt: string | null;
  commitSha: string | null;
  notes: string[];
  registryCheck: boolean;
  summary: { total: number; direct: number; outdated: number; major: number; vulnerable: number };
  items: DependencyItem[];
}

const UPDATE_LABEL = { major: 'Ana sürüm', minor: 'Ara sürüm', patch: 'Yama' } as const;
type Filter = 'all' | 'outdated' | 'vulnerable' | 'direct';

/** Dependency Center (spec §81): package, current, latest, security, risk — and an AI-prepared upgrade. */
export default function DependenciesPage() {
  const slug = useProjectSlug();
  const qc = useQueryClient();
  const toast = useToast();
  const project = useProject().data;
  const [filter, setFilter] = useState<Filter>('all');
  const [search, setSearch] = useState('');
  const [open, setOpen] = useState<DependencyItem | null>(null);
  const q = useQuery({ queryKey: ['dependencies', slug], queryFn: () => api<DependencyList>(`/projects/${slug}/dependencies`) });
  const canScan = !!project?.permissions.includes('security.manage') && project.status !== 'archived';
  const scan = useMutation({
    mutationFn: () => api(`/projects/${slug}/security/scans`, { method: 'POST' }),
    onSuccess: () => {
      toast('Tarama başladı; bitince liste güncellenir');
      const before = q.data?.scannedAt ?? null;
      const poll = setInterval(async () => {
        const fresh = await qc.fetchQuery({ queryKey: ['dependencies', slug], queryFn: () => api<DependencyList>(`/projects/${slug}/dependencies`), staleTime: 0 });
        if (fresh.scannedAt !== before) clearInterval(poll);
      }, 3000);
      setTimeout(() => clearInterval(poll), 5 * 60_000);
    },
    onError: (e) => toast(errorMessage(e), 'bad'),
  });

  return (
    <Async q={q} rows={6}>
      {(d) => {
        const rows = d.items
          .filter((i) => (filter === 'outdated' ? i.update : filter === 'vulnerable' ? i.vulnerabilities.length : filter === 'direct' ? i.direct : true))
          .filter((i) => !search || i.name.toLowerCase().includes(search.toLowerCase()));
        return (
          <>
            <div className="spread" style={{ marginBottom: 12 }}>
              <div>
                <h2 style={{ margin: 0 }}>Bağımlılıklar</h2>
                <p className="sub">
                  {d.scannedAt ? (
                    <>
                      Son tarama {ago(d.scannedAt)} · <span className="mono">{shortSha(d.commitSha)}</span>
                    </>
                  ) : (
                    'Henüz tarama yapılmadı. Liste ilk güvenlik taramasıyla oluşur.'
                  )}
                </p>
              </div>
              <div className="row">
                <a className="btn" href={`/api/v1/projects/${slug}/sbom`} title="CycloneDX 1.6 biçiminde yazılım malzeme listesi (dolaylı paketler dahil)">
                  <Download /> SBOM indir
                </a>
                {canScan && (
                  <button className="btn pri" onClick={() => scan.mutate()} disabled={scan.isPending}>
                    <ScanSearch /> Şimdi tara
                  </button>
                )}
              </div>
            </div>
            <div className="grid g5" style={{ marginBottom: 14 }}>
              <Kpi value={d.summary.total} label="Paket" />
              <Kpi value={d.summary.direct} label="Doğrudan bağımlılık" />
              <Kpi value={d.summary.outdated} label="Güncel değil" tone={d.summary.outdated ? 'warn' : 'ok'} />
              <Kpi value={d.summary.major} label="Ana sürüm geride" tone={d.summary.major ? 'warn' : 'ok'} />
              <Kpi value={d.summary.vulnerable} label="Zafiyetli" tone={d.summary.vulnerable ? 'bad' : 'ok'} />
            </div>
            {!d.registryCheck && <div className="warnbox small" style={{ marginBottom: 12 }}>Son sürüm kontrolü kapalı. Açmak için sunucu ayarlarında NPM_REGISTRY_URL / PYPI_URL / PACKAGIST_URL tanımlayın.</div>}
            {d.notes.map((n) => (
              <div key={n} className="small muted" style={{ marginBottom: 6 }}>
                {n}
              </div>
            ))}
            <div className="spread" style={{ margin: '8px 0 10px' }}>
              <Segmented
                value={filter}
                onChange={setFilter}
                items={[
                  ['all', 'Tümü'],
                  ['outdated', `Güncel değil (${d.summary.outdated})`],
                  ['vulnerable', `Zafiyetli (${d.summary.vulnerable})`],
                  ['direct', 'Doğrudan'],
                ]}
              />
              <input className="in" style={{ maxWidth: 260 }} placeholder="Paket ara" value={search} onChange={(e) => setSearch(e.target.value)} aria-label="Paket ara" />
            </div>
            <Panel flush>
              {rows.length ? (
                <div className="tbl">
                  <table>
                    <thead>
                      <tr>
                        <th>Paket</th>
                        <th>Mevcut</th>
                        <th>Son sürüm</th>
                        <th>Güvenlik</th>
                        <th>Risk</th>
                      </tr>
                    </thead>
                    <tbody>
                      {rows.map((i) => (
                        <tr key={`${i.ecosystem}|${i.name}|${i.version}`} className="click" onClick={() => setOpen(i)}>
                          <td>
                            <span className="mono">{i.name}</span> {i.ecosystem && <span className="tag">{i.ecosystem}</span>} {!i.direct && <span className="tag">dolaylı</span>}
                          </td>
                          <td className="mono small">
                            {i.version}
                            {i.approximate && <span className="muted" title="Lock dosyası yok; sürüm aralığının alt sınırı"> ~</span>}
                          </td>
                          <td className="small">
                            {i.latest ? (
                              <>
                                <span className="mono">{i.latest}</span> {i.update ? <StatusBadge status={i.update === 'major' ? 'medium' : 'low'} label={UPDATE_LABEL[i.update]} /> : <span style={{ color: 'var(--ok)' }}>✓ güncel</span>}
                              </>
                            ) : (
                              <span className="muted">—</span>
                            )}
                          </td>
                          <td className="small">
                            {i.vulnerabilities.length ? (
                              <span style={{ color: 'var(--bad)' }}>
                                {i.vulnerabilities.length} zafiyet{i.fixedVersion && <span className="muted"> · {i.fixedVersion} düzeltir</span>}
                              </span>
                            ) : (
                              <span className="muted">Bilinen zafiyet yok</span>
                            )}
                          </td>
                          <td>{i.risk === 'none' ? <StatusBadge status="healthy" label="Risk yok" /> : <StatusBadge status={i.risk} />}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                <Empty title={d.items.length ? 'Eşleşen paket yok' : 'Bağımlılık bulunamadı'}>
                  {d.items.length ? 'Filtreyi değiştirin.' : 'package.json / lock dosyaları, composer.lock, requirements.txt, go.mod veya Cargo.lock tarandığında paketler burada listelenir.'}
                </Empty>
              )}
            </Panel>
            {open && <DependencyDrawer slug={slug} item={open} canAi={!!project?.permissions.includes('ai.execute') && project.status !== 'archived'} onClose={() => setOpen(null)} />}
          </>
        );
      }}
    </Async>
  );
}

function DependencyDrawer({ slug, item, canAi, onClose }: { slug: string; item: DependencyItem; canAi: boolean; onClose: () => void }) {
  const router = useRouter();
  const toast = useToast();
  const usage = useQuery({
    queryKey: ['dependency-usage', slug, item.ecosystem, item.name],
    queryFn: () => api<{ supported: boolean; files: { path: string; line: number; text: string }[] }>(`/projects/${slug}/dependencies/usage?ecosystem=${encodeURIComponent(item.ecosystem)}&name=${encodeURIComponent(item.name)}`),
    enabled: !!item.ecosystem,
  });
  // Upgrade target: the latest release for direct packages, the first fixed release for vulnerable transitive ones.
  const target = item.direct ? (item.latest ?? item.fixedVersion) : (item.fixedVersion ?? item.latest);
  const files = usage.data?.files ?? [];
  // Server-side check: no AI task is created when the AI provider or local model is unavailable.
  const aiStatus = useQuery({ queryKey: ['aiStatus'], queryFn: () => api<{ configured: boolean; reason: string | null }>('/ai/status'), staleTime: 60_000 });
  const aiReady = aiStatus.data?.configured ?? false;
  const prepare = useMutation({
    mutationFn: () => api<{ id: string }>(`/projects/${slug}/dependencies/upgrade`, { method: 'POST', body: { ecosystem: item.ecosystem, name: item.name } }),
    onSuccess: (t) => router.push(`/projects/${slug}/ai/tasks/${t.id}`),
    onError: (e) => toast(errorMessage(e), 'bad'),
  });
  return (
    <Drawer
      title={item.name}
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            Kapat
          </button>
          {target && (
            <button className="btn pri" disabled={!canAi || !aiReady || prepare.isPending} title={!canAi ? 'AI görevi başlatma yetkiniz yok' : !aiReady ? 'AI şu an kullanılamıyor' : undefined} onClick={() => prepare.mutate()}>
              {prepare.isPending ? <span className="spinner" /> : <Bot />} Yükseltmeyi hazırla
            </button>
          )}
        </>
      }
    >
      <div className="panel" style={{ padding: 12, marginBottom: 12 }}>
        <div className="small muted" style={{ marginBottom: 4 }}>
          Analiz
        </div>
        <div style={{ display: 'grid', gap: 4, fontSize: 13 }}>
          {target ? (
            <div>
              <b>{item.name}</b> {item.version} → <b>{target}</b> sürümüne güncellenebilir.
            </div>
          ) : (
            <div>Bilinen daha yeni bir sürüm yok.</div>
          )}
          {item.update === 'major' && <div style={{ color: 'var(--warn)' }}>Ana sürüm geçişi: kırıcı değişiklik içerebilir, değişiklik notları incelenmeli.</div>}
          {item.vulnerabilities.length > 0 && <div style={{ color: 'var(--bad)' }}>{item.vulnerabilities.length} bilinen zafiyet bu sürümde açık.</div>}
          {!item.ecosystem ? null : usage.isLoading ? (
            <div className="muted">Kullanım aranıyor…</div>
          ) : usage.data?.supported ? (
            <div>
              {files.length ? `${files.length} dosyanın etkilenmesi bekleniyor` : 'Kaynak kodda doğrudan import bulunmadı'} <span className="muted">(import taramasına dayalı tahmin)</span>
            </div>
          ) : (
            <div className="muted">Bu ekosistem için etki tahmini yapılamıyor.</div>
          )}
        </div>
      </div>
      {target && canAi && aiStatus.data && !aiReady && (
        <div className="warnbox small" style={{ marginBottom: 12 }}>
          <b>“Yükseltmeyi hazırla” şu an kullanılamıyor.</b> {aiStatus.data.reason ?? 'AI yapılandırılmamış.'} Model hazır olduğunda bu düğme etkinleşir; yükseltmeyi yukarıdaki bilgilerle elle de yapabilirsiniz.
        </div>
      )}
      {item.vulnerabilities.length > 0 && (
        <>
          <div className="small muted" style={{ marginBottom: 4 }}>
            Zafiyetler
          </div>
          {item.vulnerabilities.map((v) => (
            <div key={v.id} className="small" style={{ marginBottom: 6 }}>
              <StatusBadge status={v.severity} /> <Link href={`/projects/${slug}/security?finding=${v.id}`}>SEC-{v.number}</Link> {v.advisoryId && <span className="mono">{v.advisoryId}</span>} — {v.title}
              {v.fixedVersion && <span className="muted"> · düzeltilmiş: {v.fixedVersion}</span>}
            </div>
          ))}
        </>
      )}
      {files.length > 0 && (
        <>
          <div className="small muted" style={{ margin: '10px 0 4px' }}>
            Kullanıldığı dosyalar
          </div>
          {files.slice(0, 50).map((f) => (
            <div key={f.path} className="small">
              <Link className="mono" href={`/projects/${slug}/code?path=${encodeURIComponent(f.path)}&line=${f.line}`}>
                {f.path}:{f.line}
              </Link>
            </div>
          ))}
        </>
      )}
      <p className="small muted" style={{ marginTop: 12 }}>
        Kaynak: {item.source || '—'}
        {item.approximate && ' · lock dosyası olmadığı için sürüm yaklaşık'}. &quot;Yükseltmeyi hazırla&quot; bir AI görevi açar; değişiklik ayrı bir branch&apos;te hazırlanır ve onayınız olmadan birleştirilmez.
      </p>
    </Drawer>
  );
}
