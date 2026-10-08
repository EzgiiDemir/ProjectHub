'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Bot, ScanSearch } from 'lucide-react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useState } from 'react';
import type { FindingStatus } from '@projecthub/contracts';
import { api, errorMessage } from '@/lib/api';
import { ago, dateTime, shortSha } from '@/lib/format';
import { useProject, useProjectSlug } from '@/lib/hooks';
import { FINDING_TYPE, statusLabel } from '@/lib/labels';
import type { Finding } from '@/lib/types';
import { Async, Drawer, Empty, Field, KeyValue, Kpi, Panel, ScoreBar, scoreColor, StatusBadge } from '@/components/ui';
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
    queryFn: () => api<ProjectSecurity>(`/projects/${slug}/security`),
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
  const update = useMutation({
    mutationFn: (status: FindingStatus) => api(`/security/findings/${f.id}`, { method: 'POST', body: { status, reason: reason || undefined } }),
    onSuccess: () => {
      toast('Bulgu güncellendi');
      setNext(null);
      setReason('');
      void qc.invalidateQueries({ queryKey: ['security'] });
    },
    onError: (e) => toast(errorMessage(e), 'bad'),
  });
  const aiFix = useMutation({
    mutationFn: () => api<{ id: string }>(`/projects/${slug}/ai/tasks`, { method: 'POST', body: { sourceType: 'finding', sourceId: f.id } }),
    onSuccess: (t) => router.push(`/projects/${slug}/ai/tasks/${t.id}`),
    onError: (e) => toast(errorMessage(e), 'bad'),
  });
  return (
    <Drawer title={`${f.key} · ${f.title}`} onClose={onClose}>
      <div className="row" style={{ marginBottom: 12 }}>
        <StatusBadge status={f.severity} />
        <StatusBadge status={f.status} />
        <span className="small muted">{FINDING_TYPE[f.type]}</span>
      </div>
      <p style={{ marginTop: 0, fontSize: 14 }}>{f.description}</p>
      <KeyValue
        items={[
          ['Kural', <span key="r" className="mono small">{f.ruleId}</span>],
          ...(f.filePath ? ([['Dosya', <Link key="f" className="mono small" href={`/projects/${slug}/code?path=${encodeURIComponent(f.filePath)}${f.line ? `&line=${f.line}` : ''}`}>{f.filePath}{f.line ? `:${f.line}` : ''}</Link>]] as [string, React.ReactNode][]) : []),
          ...(f.packageName ? ([['Paket', <span key="p" className="mono small">{f.packageName}@{f.packageVersion}</span>], ['Düzeltilmiş sürüm', f.fixedVersion ?? 'yok']] as [string, React.ReactNode][]) : []),
          ...(f.advisoryId ? ([['Bildirim', f.advisoryId]] as [string, React.ReactNode][]) : []),
          ['İlk görülme', dateTime(f.firstSeenAt)],
          ['Son görülme', dateTime(f.lastSeenAt)],
          ...(f.statusReason ? ([['Gerekçe', f.statusReason]] as [string, React.ReactNode][]) : []),
        ]}
      />
      {f.references.length > 0 && (
        <div style={{ marginTop: 10 }}>
          {f.references.slice(0, 5).map((r) => (
            <div key={r} className="small ellipsis">
              <a href={r} target="_blank" rel="noreferrer">
                {r}
              </a>
            </div>
          ))}
        </div>
      )}
      {canManage && (
        <div style={{ marginTop: 18 }}>
          {f.status === 'open' ? (
            <div className="row">
              <button className="btn" onClick={() => setNext('accepted')}>
                Riski kabul et
              </button>
              <button className="btn" onClick={() => setNext('false_positive')}>
                Yanlış alarm
              </button>
              {canAi && f.type !== 'dependency' && (
                <button className="btn pri" onClick={() => aiFix.mutate()} disabled={aiFix.isPending}>
                  <Bot /> AI düzeltme önersin
                </button>
              )}
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
              <button className="btn pri" disabled={reason.trim().length < 5 || update.isPending} onClick={() => update.mutate(next)}>
                Kaydet
              </button>
            </div>
          )}
        </div>
      )}
      {f.status === 'open' && <p className="small muted" style={{ marginTop: 16 }}>Kaynak düzeltildiğinde sonraki tarama bulguyu otomatik olarak “çözüldü” yapar.</p>}
    </Drawer>
  );
}
