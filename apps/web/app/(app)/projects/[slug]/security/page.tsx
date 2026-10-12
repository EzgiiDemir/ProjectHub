'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Bot, ScanSearch } from 'lucide-react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useEffect, useState } from 'react';
import type { FindingStatus } from '@projecthub/contracts';
import { api, errorMessage } from '@/lib/api';
import { ago, dateTime, shortSha } from '@/lib/format';
import { useProject, useProjectSlug } from '@/lib/hooks';
import { FINDING_TYPE, statusLabel } from '@/lib/labels';
import type { Finding } from '@/lib/types';
import { Async, CopyButton, Drawer, Empty, Field, Kpi, Panel, ScoreBar, scoreColor, StatusBadge } from '@/components/ui';
import { remediationFor } from '@/lib/remediation';
import { useToast } from '@/components/toast';

interface ProjectSecurity {
  score: number | null;
  running: boolean;
  lastScan: {
    id: string;
    commitSha: string | null;
    branch: string;
    finishedAt: string | null;
    summary: { critical: number; high: number; medium: number; low: number; breakdown: Record<string, number>; filesScanned: number; packagesScanned: number; notes: string[] } | null;
  } | null;
  counts: { status: string; severity: string; n: number }[];
  findings: Finding[];
}

const SEV_ORDER = ['critical', 'high', 'medium', 'low', 'info'];

/** Project security (spec §98–101): secrets, vulnerable dependencies, risky code and config, with a score. */
export default function SecurityPage() {
  const slug = useProjectSlug();
  const params = useSearchParams();
  const router = useRouter();
  const toast = useToast();
  const qc = useQueryClient();
  const project = useProject().data;
  const [status, setStatus] = useState('open');
  const [type, setType] = useState('');
  const q = useQuery({
    queryKey: ['security', slug],
    queryFn: () => api<ProjectSecurity>(`/projects/${slug}/security?status=all`),
    refetchInterval: (query) => (query.state.data?.running ? 3000 : false),
  });
  const canManage = !!project?.permissions.includes('security.manage') && project.status !== 'archived';
  const scan = useMutation({
    mutationFn: () => api(`/projects/${slug}/security/scans`, { method: 'POST' }),
    onSuccess: () => {
      toast('Tarama başladı');
      void qc.invalidateQueries({ queryKey: ['security', slug] });
    },
    onError: (e) => toast(errorMessage(e), 'bad'),
  });
  const openId = params.get('finding');

  return (
    <Async q={q} rows={6}>
      {(s) => {
        const open = (sev: string) => s.counts.filter((c) => c.status === 'open' && c.severity === sev).reduce((a, c) => a + c.n, 0);
        const rows = s.findings
          .filter((f) => (status === 'all' ? true : status === 'open' ? f.status === 'open' : f.status !== 'open'))
          .filter((f) => !type || f.type === type)
          .sort((a, b) => SEV_ORDER.indexOf(a.severity) - SEV_ORDER.indexOf(b.severity));
        const selected = s.findings.find((f) => f.id === openId);
        return (
          <>
            <div className="spread" style={{ marginBottom: 12 }}>
              <div>
                <h2 style={{ margin: 0 }}>Güvenlik</h2>
                <p className="sub">
                  {s.lastScan ? (
                    <>
                      Son tarama {ago(s.lastScan.finishedAt)} · {s.lastScan.branch} <span className="mono">{shortSha(s.lastScan.commitSha)}</span>
                      {s.lastScan.summary && ` · ${s.lastScan.summary.filesScanned} dosya, ${s.lastScan.summary.packagesScanned} paket`}
                    </>
                  ) : (
                    'Henüz tarama yapılmadı.'
                  )}
                </p>
              </div>
              {canManage && (
                <button className="btn pri" onClick={() => scan.mutate()} disabled={scan.isPending || s.running}>
                  {s.running ? <span className="spinner" /> : <ScanSearch />} {s.running ? 'Taranıyor…' : 'Şimdi tara'}
                </button>
              )}
            </div>
            <div className="grid g6" style={{ marginBottom: 14 }}>
              <Kpi value={s.score ?? '—'} color={scoreColor(s.score)} label="Güvenlik skoru" />
              <Kpi value={open('critical')} label="Kritik" tone={open('critical') ? 'bad' : undefined} />
              <Kpi value={open('high')} label="Yüksek" tone={open('high') ? 'bad' : undefined} />
              <Kpi value={open('medium')} label="Orta" tone={open('medium') ? 'warn' : undefined} />
              <Kpi value={open('low')} label="Düşük" />
              <Kpi value={s.counts.filter((c) => c.status === 'resolved').reduce((a, c) => a + c.n, 0)} label="Çözülen" tone="ok" />
            </div>
            {open('critical') > 0 && <div className="badbox" style={{ marginBottom: 14 }}>Açık kritik bulgu varken production deployment engellenir.</div>}
            <div className="grid" style={{ gridTemplateColumns: 'minmax(0, 1fr) 280px', alignItems: 'start' }}>
              <div>
                <div className="spread" style={{ marginBottom: 10 }}>
                  <div className="row">
                    {[
                      ['open', 'Açık'],
                      ['closed', 'Kapanan'],
                      ['all', 'Tümü'],
                    ].map(([k, l]) => (
                      <button key={k} className={`chip ${status === k ? 'on' : ''}`} onClick={() => setStatus(k!)}>
                        {l}
                      </button>
                    ))}
                  </div>
                  <select className="in" style={{ width: 'auto' }} value={type} onChange={(e) => setType(e.target.value)} aria-label="Tür">
                    <option value="">Tüm türler</option>
                    {Object.entries(FINDING_TYPE).map(([k, l]) => (
                      <option key={k} value={k}>
                        {l}
                      </option>
                    ))}
                  </select>
                </div>
                {rows.length ? (
                  <Panel flush>
                    <div className="tbl">
                      <table>
                        <tbody>
                          {rows.map((f) => (
                            <tr key={f.id} className="click" onClick={() => router.replace(`/projects/${slug}/security?finding=${f.id}`)}>
                              <td style={{ width: 90 }}>
                                <StatusBadge status={f.severity} />
                              </td>
                              <td>
                                <div>
                                  <span className="mono small muted">{f.key}</span> {f.title}
                                </div>
                                <div className="small muted mono ellipsis" style={{ maxWidth: 520 }}>
                                  {f.type === 'dependency' ? `${f.packageName}@${f.packageVersion}${f.fixedVersion ? ` → ${f.fixedVersion}` : ''}${f.advisoryId ? ` · ${f.advisoryId}` : ''}` : f.filePath ? `${f.filePath}${f.line ? `:${f.line}` : ''}` : FINDING_TYPE[f.type]}
                                </div>
                              </td>
                              <td className="small">{FINDING_TYPE[f.type]}</td>
                              <td>{f.status !== 'open' && <StatusBadge status={f.status} />}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </Panel>
                ) : (
                  <Empty title={status === 'open' ? 'Açık bulgu yok' : 'Bulgu yok'} />
                )}
              </div>
              <Panel title="Skor kırılımı">
                {s.lastScan?.summary ? (
                  <>
                    {Object.entries(s.lastScan.summary.breakdown).map(([k, v]) => (
                      <ScoreBar key={k} label={FINDING_TYPE[k] ?? k} value={v} />
                    ))}
                    {s.lastScan.summary.notes.map((n) => (
                      <p key={n} className="small muted">
                        {n}
                      </p>
                    ))}
                  </>
                ) : (
                  <p className="small muted">Tarama sonrası hesaplanır.</p>
                )}
                <p className="small muted" style={{ marginBottom: 0 }}>
                  Taramalar: kod içi secret&apos;lar, OSV.dev bağımlılık açıkları, riskli kod kalıpları ve yapılandırma. Varsayılan branch&apos;e her commit&apos;te ve her build&apos;de çalışır.
                </p>
              </Panel>
            </div>
            {selected && <FindingDrawer slug={slug} finding={selected} canManage={canManage} canAi={!!project?.permissions.includes('ai.execute')} onClose={() => router.replace(`/projects/${slug}/security`)} />}
          </>
        );
      }}
    </Async>
  );
}

function FindingDrawer({ slug, finding: f, canManage, canAi, onClose }: { slug: string; finding: Finding; canManage: boolean; canAi: boolean; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const router = useRouter();
  const [next, setNext] = useState<FindingStatus | null>(null);
  const [reason, setReason] = useState('');
  const [scanId, setScanId] = useState<string | null>(null);
  const r = remediationFor(f, slug);
  const refresh = () => void qc.invalidateQueries({ queryKey: ['security'] });
  const update = useMutation({
    mutationFn: (status: FindingStatus) => api(`/security/findings/${f.id}`, { method: 'POST', body: { status, reason: reason || undefined } }),
    onSuccess: () => {
      toast('Bulgu güncellendi');
      setNext(null);
      setReason('');
      refresh();
    },
    onError: (e) => toast(errorMessage(e), 'bad'),
  });
  const resolve = useMutation({
    mutationFn: () => api<{ scanId: string }>(`/security/findings/${f.id}/resolve`, { method: 'POST', body: {} }),
    onSuccess: (res) => {
      setScanId(res.scanId);
      refresh();
    },
    onError: (e) => toast(errorMessage(e), 'bad'),
  });
  // Live result of the verification scan started by "Çözüldü".
  const verification = useQuery({
    queryKey: ['finding-verification', f.id, scanId],
    queryFn: () => api<{ state: 'pending' | 'verified' | 'still_present' | 'unverifiable'; message: string }>(`/security/findings/${f.id}/verification?scanId=${scanId}`),
    enabled: !!scanId,
    refetchInterval: (q) => (q.state.data?.state === 'pending' || !q.state.data ? 2500 : false),
  });
  const v = verification.data;
  useEffect(() => {
    if (v && v.state !== 'pending') refresh();
  }, [v?.state]);
  const aiFix = useMutation({
    mutationFn: () => api<{ id: string }>(`/projects/${slug}/ai/tasks`, { method: 'POST', body: { sourceType: 'finding', sourceId: f.id } }),
    onSuccess: (t) => router.push(`/projects/${slug}/ai/tasks/${t.id}`),
    onError: (e) => toast(errorMessage(e), 'bad'),
  });
  const verifyTone = !v || v.state === 'pending' ? 'run' : v.state === 'verified' ? 'ok' : v.state === 'still_present' ? 'bad' : 'warn';
  return (
    <Drawer title={`${f.key} · ${f.title}`} onClose={onClose} wide>
      <div className="row" style={{ marginBottom: 16, gap: 8 }}>
        <StatusBadge status={f.severity} />
        <StatusBadge status={f.status} />
        <span className="tag">{FINDING_TYPE[f.type]}</span>
        <span className="small muted">
          İlk görülme {dateTime(f.firstSeenAt)} · son tarama {ago(f.lastSeenAt)}
        </span>
      </div>

      <section className="fx-section">
        <h3>Sorun</h3>
        <p>{r.problem}</p>
        {r.where && (
          <p className="small">
            Nerede:{' '}
            {f.filePath ? (
              <Link className="mono" href={`/projects/${slug}/code?path=${encodeURIComponent(f.filePath)}${f.line ? `&line=${f.line}` : ''}`}>
                {r.where}
              </Link>
            ) : (
              <span className="mono">{r.where}</span>
            )}
          </p>
        )}
        {f.type === 'dependency' && f.packageName && (
          <p className="small muted">
            Paket <span className="mono">{f.packageName}@{f.packageVersion}</span>
            {f.advisoryId && <> · {f.advisoryId}</>}
            {f.fixedVersion && <> · düzeltilmiş sürüm <b className="mono">{f.fixedVersion}</b></>}
          </p>
        )}
      </section>

      <section className="fx-section">
        <h3>Çözüm</h3>
        <ol className="fx-steps">
          {r.steps.map((s) => (
            <li key={s}>{s}</li>
          ))}
        </ol>
        {r.command && (
          <div className="fx-command">
            <span className="small muted">{r.command.label}</span>
            <code className="mono">{r.command.text}</code>
            <CopyButton text={r.command.text} />
          </div>
        )}
      </section>

      {(r.links.length > 0 || (canAi && f.status === 'open')) && (
        <section className="fx-section">
          <h3>İşlemler</h3>
          <div className="row" style={{ flexWrap: 'wrap', gap: 8 }}>
            {r.links.map((l) =>
              l.external ? (
                <a key={l.href} className="btn" href={l.href} target="_blank" rel="noreferrer">
                  {l.label} ↗
                </a>
              ) : (
                <Link key={l.href} className="btn" href={l.href}>
                  {l.label}
                </Link>
              ),
            )}
            {canAi && f.status === 'open' && f.type !== 'dependency' && (
              <button className="btn" onClick={() => aiFix.mutate()} disabled={aiFix.isPending}>
                <Bot /> AI düzeltme önersin
              </button>
            )}
          </div>
        </section>
      )}

      {scanId && (
        <div className={`fx-verify ${verifyTone}`} role="status">
          {(!v || v.state === 'pending') && <span className="spinner" />}
          <div>
            <b>{!v || v.state === 'pending' ? 'Çözüm doğrulanıyor' : v.state === 'verified' ? 'Çözüldü ve doğrulandı' : v.state === 'still_present' ? 'Sorun hâlâ mevcut' : 'Doğrulanamadı'}</b>
            <div className="small">{v?.message ?? 'Varsayılan branch yeniden taranıyor…'}</div>
          </div>
        </div>
      )}

      {f.statusReason && f.status !== 'open' && (
        <p className="small muted">
          {statusLabel(f.status)} gerekçesi: {f.statusReason}
        </p>
      )}

      {canManage && (
        <div className="fx-actions">
          {f.status === 'open' ? (
            <div className="row" style={{ flexWrap: 'wrap', gap: 8 }}>
              <button className="btn" onClick={() => setNext('false_positive')}>
                Yanlış alarm
              </button>
              <button className="btn pri" onClick={() => resolve.mutate()} disabled={resolve.isPending || (!!scanId && (!v || v.state === 'pending'))} title="Bulguyu çözüldü olarak işaretler ve hemen yeniden tarayarak doğrular">
                {resolve.isPending ? <span className="spinner" /> : '✓'} Çözüldü
              </button>
              <button className="btn" onClick={() => setNext('accepted')}>
                Riski kabul et
              </button>
            </div>
          ) : (
            f.status !== 'resolved' && (
              <button className="btn" onClick={() => update.mutate('open')} disabled={update.isPending}>
                Yeniden aç
              </button>
            )
          )}
          {next && (
            <div style={{ marginTop: 12 }}>
              <Field label={`${statusLabel(next)} — gerekçe`} id="fd-reason" hint="Denetim kaydına yazılır. Kabul edilen bulgular production'ı engellemez.">
                <textarea id="fd-reason" className="in" value={reason} onChange={(e) => setReason(e.target.value)} maxLength={1000} />
              </Field>
              <div className="row">
                <button className="btn" onClick={() => setNext(null)}>
                  Vazgeç
                </button>
                <button className="btn pri" disabled={reason.trim().length < 5 || update.isPending} onClick={() => update.mutate(next)}>
                  Kaydet
                </button>
              </div>
            </div>
          )}
        </div>
      )}
      <p className="small muted" style={{ marginTop: 14 }}>
        Kural: <span className="mono">{f.ruleId}</span>. Kaynak düzeltildiğinde her tarama bulguyu kendiliğinden kapatır; “Çözüldü” bunu hemen kontrol eder.
      </p>
    </Drawer>
  );
}
