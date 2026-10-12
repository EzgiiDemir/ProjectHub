'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import type { AiSettings } from '@projecthub/contracts';
import { api, errorMessage } from '@/lib/api';
import { ago } from '@/lib/format';
import { AI_LEVEL } from '@/lib/labels';
import type { AiStatus } from '@/lib/types';
import { Async, Field, Kpi, PageHeader, Panel, StatusBadge } from '@/components/ui';
import { useToast } from '@/components/toast';

interface Usage {
  byPurpose: { purpose: string; runs: number; failed: number; tokens: number }[];
  recent: { id: string; purpose: string; provider: string; model: string; inputTokens: number; outputTokens: number; status: string; error: string | null; startedAt: string; projectName: string | null; projectSlug: string | null; userName: string | null }[];
  denied: { id: string; action: string; resource: string | null; riskLevel: string; createdAt: string }[];
}

interface Portfolio {
  projectCount: number;
  sharedTechnologies: { name: string; projects: { id: string; name: string; slug: string }[] }[];
  sharedModules: { name: string; projects: { id: string; name: string; slug: string }[] }[];
  sharedDependencies: { name: string; ecosystem: string; versionDrift: boolean; projects: { id: string; name: string; slug: string; versions: string[] }[] }[];
  versionDrift: { name: string; ecosystem: string; projects: { id: string; name: string; slug: string; versions: string[] }[] }[];
}

const PURPOSE: Record<string, string> = { project_qa: 'Proje soru-cevap', build_analysis: 'Build hata analizi', feedback_triage: 'Geri bildirim ön değerlendirme', fix_agent: 'Düzeltme görevi', postmortem: 'Post-mortem taslağı' };
const POLICIES: [keyof AiSettings['policies'], string, string][] = [
  ['createBranch', 'Branch açabilir', 'Her görev için ai/AI-n-… branch’i'],
  ['commitToAiBranch', 'Kendi branch’ine commit edebilir', 'Yalnızca AI branch’ine; varsayılan branch’e asla'],
  ['runBuilds', 'Değişikliğini build ile doğrular', 'Onaydan önce build ve testler çalışır'],
  ['createPreview', 'Ön izleme açabilir (L3)', 'Doğrulanan değişikliği ön izlemede dener'],
];

/** AI control center (spec §25–28): provider, autonomy level, policies, budget and an audit of AI behaviour. */
export default function AiControlPage() {
  const qc = useQueryClient();
  const toast = useToast();
  const settings = useQuery({ queryKey: ['adminSettings'], queryFn: () => api<{ ai: AiSettings; aiProviders: { ollama: boolean; anthropic: boolean; openai: boolean } }>('/admin/settings') });
  const status = useQuery({ queryKey: ['aiStatus'], queryFn: () => api<AiStatus>('/ai/status') });
  const usage = useQuery({ queryKey: ['aiUsage'], queryFn: () => api<Usage>('/admin/ai/usage') });
  const portfolio = useQuery({ queryKey: ['aiPortfolio'], queryFn: () => api<Portfolio>('/ai/portfolio') });
  const [v, setV] = useState<AiSettings | null>(null);
  useEffect(() => {
    if (settings.data && !v) setV(settings.data.ai);
  }, [settings.data, v]);
  const save = useMutation({
    mutationFn: () => api('/admin/settings/ai', { method: 'PUT', body: v }),
    onSuccess: () => {
      toast('AI ayarları kaydedildi');
      void qc.invalidateQueries({ queryKey: ['adminSettings'] });
      void qc.invalidateQueries({ queryKey: ['aiStatus'] });
    },
  });
  const keys = settings.data?.aiProviders;
  const stopAutonomy = useMutation({
    mutationFn: () => api('/admin/settings/ai', { method: 'PUT', body: { ...settings.data!.ai, autonomyLevel: 'L1' } }),
    onSuccess: () => {
      toast('Otonom değişiklikler durduruldu: AI artık yalnızca okur ve açıklar (L1)');
      setV(null);
      void qc.invalidateQueries({ queryKey: ['adminSettings'] });
      void qc.invalidateQueries({ queryKey: ['aiStatus'] });
    },
  });

  return (
    <div className="page">
      <PageHeader title="AI kontrol merkezi" sub="AI ne kadar yetkili, hangi sağlayıcıyla, hangi bütçeyle çalışır. AI production'a deploy edemez ve kendi değişikliğini birleştiremez; bu kurallar ayarlardan bağımsızdır." />
      {status.data && (
        <div className="grid g4" style={{ marginBottom: 14 }}>
          <Kpi value={status.data.configured ? 'Hazır' : 'Kapalı'} label={status.data.configured ? `${status.data.provider} · ${status.data.model}` : 'AI durumu'} tone={status.data.configured ? 'ok' : 'warn'} />
          <Kpi value={status.data.autonomyLevel} label={AI_LEVEL[status.data.autonomyLevel] ?? ''} />
          <Kpi value={status.data.monthlyTokensUsed.toLocaleString('tr-TR')} label={`Bu ay token · bütçe ${status.data.monthlyTokenBudget ? status.data.monthlyTokenBudget.toLocaleString('tr-TR') : 'sınırsız'}`} tone={status.data.monthlyTokenBudget && status.data.monthlyTokensUsed > status.data.monthlyTokenBudget * 0.8 ? 'warn' : undefined} />
          <Kpi value={usage.data?.byPurpose.reduce((a, p) => a + p.runs, 0) ?? '—'} label="Bu ay AI çağrısı" />
        </div>
      )}
      {status.data && !status.data.configured && <div className="warnbox" style={{ marginBottom: 14 }}>{status.data.reason}</div>}
      {status.data && (
        <div style={{ marginBottom: 14 }}>
          <Panel title="Yerel model çalışma zamanı">
            <div className="grid g4">
              <Kpi value={status.data.localRuntime.reachable ? 'Bağlı' : 'Ulaşılamıyor'} label={`Ollama${status.data.localRuntime.version ? ` · ${status.data.localRuntime.version}` : ''}`} tone={status.data.localRuntime.reachable ? 'ok' : 'warn'} />
              <Kpi value={status.data.localRuntime.models.length} label="Yüklü model" />
              <Kpi value={status.data.localRuntime.loadedModels.length} label="Bellekte etkin model" />
              <Kpi value={status.data.localRuntime.loadedModels.reduce((sum, item) => sum + (item.sizeVram ?? 0), 0) ? `${(status.data.localRuntime.loadedModels.reduce((sum, item) => sum + (item.sizeVram ?? 0), 0) / 1024 ** 3).toFixed(1)} GB` : '—'} label="Model VRAM" />
            </div>
            {status.data.localRuntime.models.length > 0 && (
              <div className="small muted mt">
                {status.data.localRuntime.models.map((item) => `${item.name}${item.parameterSize ? ` · ${item.parameterSize}` : ''}${item.quantization ? ` · ${item.quantization}` : ''}`).join('  |  ')}
              </div>
            )}
          </Panel>
        </div>
      )}
      <AiOperations level={settings.data?.ai.autonomyLevel} onStopAutonomy={() => stopAutonomy.mutate()} stopping={stopAutonomy.isPending} />
      <div className="grid split mt" style={{ alignItems: 'start' }}>
        <Panel title="Ayarlar">
          {!v ? (
            <span className="spinner" />
          ) : (
            <>
              <div className="grid g2">
                <Field label="Sağlayıcı" id="ai-prov" hint="Ollama yerel ve anahtarsızdır; bulut sağlayıcı anahtarları yalnızca sunucu ortamından okunur">
                  <select id="ai-prov" className="in" value={v.provider ?? ''} onChange={(e) => setV({ ...v, provider: (e.target.value || null) as AiSettings['provider'], model: null })}>
                    <option value="">Varsayılan (yerel Ollama)</option>
                    <option value="ollama">Ollama · yerel {status.data?.localRuntime.reachable ? '' : '· ulaşılamıyor'}</option>
                    <option value="anthropic">Anthropic Claude {keys?.anthropic ? '' : '· anahtar yok'}</option>
                    <option value="openai">OpenAI {keys?.openai ? '' : '· anahtar yok'}</option>
                  </select>
                </Field>
                <Field label="Model" id="ai-model" hint={v.provider === 'ollama' || !v.provider ? 'Boşsa sunucudaki OLLAMA_MODEL kullanılır' : v.provider === 'openai' ? 'OpenAI için zorunlu' : 'Boşsa sağlayıcının varsayılanı kullanılır'}>
                  <input id="ai-model" className="in mono" list="ollama-models" value={v.model ?? ''} onChange={(e) => setV({ ...v, model: e.target.value.trim() || null })} placeholder={v.provider === 'ollama' || !v.provider ? 'qwen2.5-coder:7b' : v.provider === 'openai' ? 'model adı' : 'claude-opus-5-5'} />
                  <datalist id="ollama-models">{status.data?.localRuntime.models.map((item) => <option key={item.name} value={item.name} />)}</datalist>
                </Field>
              </div>
              <Field label="Otonomi seviyesi" id="ai-level">
                <select id="ai-level" className="in" value={v.autonomyLevel} onChange={(e) => setV({ ...v, autonomyLevel: e.target.value as AiSettings['autonomyLevel'] })}>
                  {Object.entries(AI_LEVEL).map(([k, l]) => (
                    <option key={k} value={k}>
                      {k} · {l}
                    </option>
                  ))}
                </select>
              </Field>
              <div className="field">
                <label>Politikalar</label>
                {POLICIES.map(([k, label, hint]) => (
                  <label key={k} className="check" style={{ alignItems: 'flex-start' }}>
                    <input type="checkbox" checked={v.policies[k]} onChange={(e) => setV({ ...v, policies: { ...v.policies, [k]: e.target.checked } })} />
                    <span>
                      {label}
                      <div className="small muted">{hint}</div>
                    </span>
                  </label>
                ))}
              </div>
              <div className="grid g2">
                <Field label="Aylık token bütçesi" id="ai-budget" hint="0 = sınırsız. Dolunca yeni AI istekleri reddedilir.">
                  <input id="ai-budget" className="in" type="number" min={0} step={100000} value={v.monthlyTokenBudget} onChange={(e) => setV({ ...v, monthlyTokenBudget: Math.max(0, Number(e.target.value) || 0) })} />
                </Field>
                <Field label="Görev başına en fazla adım" id="ai-steps" hint="Ajanın dosya okuma/yazma adım sınırı">
                  <input id="ai-steps" className="in" type="number" min={1} max={100} value={v.maxAgentSteps} onChange={(e) => setV({ ...v, maxAgentSteps: Math.min(100, Math.max(1, Number(e.target.value) || 1)) })} />
                </Field>
              </div>
              <div className="field">
                <label>Kontrollü kendini iyileştirme</label>
                <label className="check" style={{ alignItems: 'flex-start' }}>
                  <input type="checkbox" checked={v.selfHealing.enabled} onChange={(e) => setV({ ...v, selfHealing: { ...v.selfHealing, enabled: e.target.checked } })} />
                  <span>
                    Düşük riskli iyileştirme akışlarına izin ver
                    <div className="small muted">Yalnızca açıkça izin verilen, geri alınabilir işlemler; deployment, migration, yetki ve secret değişikliği kapsam dışıdır.</div>
                  </span>
                </label>
                <label className="check" style={{ alignItems: 'flex-start' }}>
                  <input type="checkbox" checked={v.selfHealing.emergencyStop} onChange={(e) => setV({ ...v, selfHealing: { ...v.selfHealing, emergencyStop: e.target.checked } })} />
                  <span>
                    Acil durdurma etkin
                    <div className="small muted">Etkin olduğunda yeni otomatik iyileştirme başlatılmaz.</div>
                  </span>
                </label>
                <label className="check" style={{ alignItems: 'flex-start' }}>
                  <input type="checkbox" checked={v.selfHealing.autoRecheckHealth} disabled={!v.selfHealing.enabled || v.selfHealing.emergencyStop} onChange={(e) => setV({ ...v, selfHealing: { ...v.selfHealing, autoRecheckHealth: e.target.checked } })} />
                  <span>
                    İzleme olaylarında sağlık kontrolünü otomatik tekrarla
                    <div className="small muted">Yalnızca tanılama amaçlı HTTP sağlık kontrolüdür; ortamı veya production verisini değiştirmez.</div>
                  </span>
                </label>
                <Field label="Saatlik en fazla otomatik deneme" id="self-heal-limit">
                  <input id="self-heal-limit" className="in" type="number" min={1} max={10} value={v.selfHealing.maxAttemptsPerHour} onChange={(e) => setV({ ...v, selfHealing: { ...v.selfHealing, maxAttemptsPerHour: Math.min(10, Math.max(1, Number(e.target.value) || 1)) } })} />
                </Field>
              </div>
              {save.error && <div className="badbox">{errorMessage(save.error)}</div>}
              <button className="btn pri" onClick={() => save.mutate()} disabled={save.isPending || (v.provider === 'openai' && !v.model)}>
                Kaydet
              </button>
            </>
          )}
        </Panel>
        <Panel title="Bu ayın kullanımı">
          <Async q={usage}>
            {(u) =>
              u.byPurpose.length ? (
                <dl className="kv">
                  {u.byPurpose.map((p) => (
                    <div key={p.purpose} style={{ display: 'contents' }}>
                      <dt>{PURPOSE[p.purpose] ?? p.purpose}</dt>
                      <dd>
                        {p.runs} çağrı · {p.tokens.toLocaleString('tr-TR')} token{p.failed ? <span style={{ color: 'var(--bad)' }}> · {p.failed} hata</span> : ''}
                      </dd>
                    </div>
                  ))}
                </dl>
              ) : (
                <p className="small muted" style={{ margin: 0 }}>Bu ay AI kullanılmadı.</p>
              )
            }
          </Async>
        </Panel>
      </div>
      <Panel title="İzinli proje portföyü" className="mt">
        <Async q={portfolio}>
          {(data) => (
            <div className="grid g3">
              <div>
                <div className="small muted">Ortak teknolojiler · {data.projectCount} görünür proje</div>
                {data.sharedTechnologies.slice(0, 12).map((item) => <div key={item.name} className="list-item small"><span>{item.name}</span><span className="muted">{item.projects.length} proje</span></div>)}
                {!data.sharedTechnologies.length && <p className="small muted">En az iki projede ortak teknoloji henüz bulunmadı.</p>}
              </div>
              <div>
                <div className="small muted">Ortak bağımlılıklar</div>
                {data.sharedDependencies.slice(0, 12).map((item) => <div key={`${item.ecosystem}:${item.name}`} className="list-item small"><span>{item.name}</span><span className="muted">{item.projects.length} proje</span></div>)}
                {!data.sharedDependencies.length && <p className="small muted">Bağımlılık envanteri güvenlik taramalarından sonra oluşur.</p>}
              </div>
              <div>
                <div className="small muted">Sürüm sapmaları</div>
                {data.versionDrift.slice(0, 12).map((item) => <div key={`${item.ecosystem}:${item.name}`} className="list-item small"><span>{item.name}</span><StatusBadge status="warning" label={`${item.projects.length} proje`} /></div>)}
                {!data.versionDrift.length && <p className="small muted">Ortak bağımlılıklarda doğrulanmış sürüm sapması yok.</p>}
              </div>
            </div>
          )}
        </Async>
      </Panel>
      <Async q={usage}>
        {(u) => (
          <>
            <Panel title="Son AI çağrıları" flush className="mt">
              {u.recent.length ? (
                <div className="tbl">
                  <table>
                    <thead>
                      <tr>
                        <th>Zaman</th>
                        <th>Amaç</th>
                        <th>Proje</th>
                        <th>Kullanıcı</th>
                        <th>Model</th>
                        <th>Token</th>
                        <th>Durum</th>
                      </tr>
                    </thead>
                    <tbody>
                      {u.recent.map((r) => (
                        <tr key={r.id}>
                          <td className="small muted">{ago(r.startedAt)}</td>
                          <td className="small">{PURPOSE[r.purpose] ?? r.purpose}</td>
                          <td className="small">{r.projectSlug ? <Link href={`/projects/${r.projectSlug}`}>{r.projectName}</Link> : '—'}</td>
                          <td className="small">{r.userName ?? 'sistem'}</td>
                          <td className="mono small">{r.model}</td>
                          <td className="mono small">{(r.inputTokens + r.outputTokens).toLocaleString('tr-TR')}</td>
                          <td>
                            <StatusBadge status={r.status === 'completed' ? 'completed' : r.status} />
                            {r.error && <div className="small ellipsis" style={{ color: 'var(--bad)', maxWidth: 260 }}>{r.error}</div>}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                <p className="small muted" style={{ padding: 16, margin: 0 }}>Kayıt yok.</p>
              )}
            </Panel>
            {u.denied.length > 0 && (
              <Panel title="Politika tarafından engellenen AI işlemleri" flush className="mt">
                {u.denied.map((d) => (
                  <div key={d.id} className="list-item small">
                    <span className="mono">{d.action}</span>
                    <span className="muted ellipsis" style={{ flex: 1 }}>
                      {d.resource}
                    </span>
                    <StatusBadge status={d.riskLevel} />
                    <span className="muted">{ago(d.createdAt)}</span>
                  </div>
                ))}
              </Panel>
            )}
          </>
        )}
      </Async>
    </div>
  );
}

interface Operations {
  active: OpsTask[];
  approvals: OpsTask[];
  queue: { queued: number; running: number; failed24h: number };
  index: { projectId: string; name: string; slug: string; files: number; lastIndexedAt: string | null; chunks: number; embedded: number; memories: number; verifiedMemories: number }[];
  host: { cpuCount: number; cpuPercent: number | null; memoryTotal: number; memoryFree: number; gpus: { name: string; utilization: number; memoryUsedMb: number; memoryTotalMb: number }[] | null };
}
interface OpsTask { id: string; key: string; type: string; title: string; status: string; autonomyLevel: string; startedAt: string | null; createdAt: string; projectName: string; projectSlug: string; requestedBy: string | null }

const GB = 1024 ** 3;

/** Live operations: host resources, AI queue, tasks waiting for a human and per-project knowledge status. */
function AiOperations({ level, onStopAutonomy, stopping }: { level: string | undefined; onStopAutonomy: () => void; stopping: boolean }) {
  const qc = useQueryClient();
  const toast = useToast();
  const ops = useQuery({ queryKey: ['aiOps'], queryFn: () => api<Operations>('/admin/ai/operations'), refetchInterval: 10_000 });
  const cancel = useMutation({
    mutationFn: (id: string) => api(`/ai/tasks/${id}/cancel`, { method: 'POST', body: {} }),
    onSuccess: () => {
      toast('Görev iptal edildi');
      void qc.invalidateQueries({ queryKey: ['aiOps'] });
    },
    onError: (e) => toast(errorMessage(e), 'bad'),
  });
  const reindex = useMutation({
    mutationFn: (projectId: string) => api(`/projects/${projectId}/ai/reindex`, { method: 'POST', body: {} }),
    onSuccess: () => toast('Yeniden indeksleme kuyruğa alındı'),
    onError: (e) => toast(errorMessage(e), 'bad'),
  });
  return (
    <Async q={ops}>
      {(o) => {
        const memUsed = o.host.memoryTotal - o.host.memoryFree;
        const gpu = o.host.gpus?.[0];
        const taskRow = (t: OpsTask, approval: boolean) => (
          <div key={t.id} className="list-item">
            <span className="mono small">{t.key}</span>
            <span style={{ flex: 1, minWidth: 0 }}>
              <Link href={`/projects/${t.projectSlug}/ai/tasks/${t.id}`} className="ellipsis" style={{ display: 'block' }}>{t.title}</Link>
              <span className="small muted">{t.projectName} · {t.type} · {t.requestedBy ?? 'sistem'} · {ago(t.startedAt ?? t.createdAt)}</span>
            </span>
            <StatusBadge status={t.status} />
            {approval ? (
              <Link className="btn sm pri" href={`/projects/${t.projectSlug}/ai/tasks/${t.id}`}>Değişikliği incele</Link>
            ) : (
              <button className="btn sm" onClick={() => cancel.mutate(t.id)} disabled={cancel.isPending}>İptal et</button>
            )}
          </div>
        );
        return (
          <>
            <div className="grid g4" style={{ marginBottom: 14 }}>
              <Kpi value={o.host.cpuPercent != null ? `%${o.host.cpuPercent}` : '—'} label={`CPU · ${o.host.cpuCount} çekirdek`} tone={o.host.cpuPercent != null && o.host.cpuPercent > 85 ? 'warn' : undefined} />
              <Kpi value={`${(memUsed / GB).toFixed(1)} / ${(o.host.memoryTotal / GB).toFixed(0)} GB`} label="RAM kullanımı" tone={memUsed / o.host.memoryTotal > 0.9 ? 'warn' : undefined} />
              <Kpi value={gpu ? `%${gpu.utilization}` : '—'} label={gpu ? `${gpu.name} · ${(gpu.memoryUsedMb / 1024).toFixed(1)}/${(gpu.memoryTotalMb / 1024).toFixed(0)} GB VRAM` : 'GPU ölçülemiyor (CPU modu)'} />
              <Kpi value={`${o.queue.running} / ${o.queue.queued}`} label={`AI kuyruğu: çalışan / bekleyen${o.queue.failed24h ? ` · 24 sa ${o.queue.failed24h} hata` : ''}`} tone={o.queue.failed24h ? 'warn' : undefined} />
            </div>
            <div className="grid split" style={{ alignItems: 'start', marginBottom: 14 }}>
              <Panel title={`Onay bekleyen değişiklikler · ${o.approvals.length}`} flush>
                {o.approvals.length ? o.approvals.map((t) => taskRow(t, true)) : <p className="small muted" style={{ padding: 16, margin: 0 }}>Onay bekleyen AI değişikliği yok. AI hiçbir değişikliği kendi başına birleştiremez.</p>}
              </Panel>
              <Panel
                title={`Çalışan / sıradaki görevler · ${o.active.length}`}
                flush
                actions={
                  level && level !== 'L0' && level !== 'L1' ? (
                    <button className="btn sm" onClick={onStopAutonomy} disabled={stopping} title="Otonomiyi L1'e indirir: AI yalnızca okur ve açıklar, kod değiştiremez">
                      Otonom değişiklikleri durdur
                    </button>
                  ) : undefined
                }
              >
                {o.active.length ? o.active.map((t) => taskRow(t, false)) : <p className="small muted" style={{ padding: 16, margin: 0 }}>Şu an çalışan AI görevi yok.</p>}
              </Panel>
            </div>
            <Panel title="Proje bilgisi ve indeks durumu" flush>
              <div className="tbl">
                <table>
                  <thead>
                    <tr>
                      <th>Proje</th>
                      <th>İndekslenen dosya</th>
                      <th>Kod parçası</th>
                      <th>Anlamsal (embedding)</th>
                      <th>Bellek kaydı</th>
                      <th>Son indeks</th>
                      <th />
                    </tr>
                  </thead>
                  <tbody>
                    {o.index.map((p) => (
                      <tr key={p.projectId}>
                        <td><Link href={`/projects/${p.slug}/ai?tab=memory`}>{p.name}</Link></td>
                        <td className="mono small">{p.files}</td>
                        <td className="mono small">{p.chunks}</td>
                        <td className="small">{p.chunks ? `%${Math.round((p.embedded / p.chunks) * 100)}` : '—'}{p.chunks && p.embedded < p.chunks ? <span className="muted"> · kalan kelime aramasıyla</span> : ''}</td>
                        <td className="small">{p.memories} <span className="muted">({p.verifiedMemories} doğrulanmış)</span></td>
                        <td className="small muted">{p.lastIndexedAt ? ago(p.lastIndexedAt) : 'henüz yok'}</td>
                        <td><button className="btn sm" onClick={() => reindex.mutate(p.projectId)} disabled={reindex.isPending}>Yeniden indeksle</button></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Panel>
          </>
        );
      }}
    </Async>
  );
}
