'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Bot, Plus, RefreshCw } from 'lucide-react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useEffect, useState } from 'react';
import { api, errorMessage } from '@/lib/api';
import { ago, dateTime, duration, time } from '@/lib/format';
import { useProject, useProjectSlug } from '@/lib/hooks';
import { EVENT_KIND } from '@/lib/labels';
import type { Environment, Incident, ProjectEvent } from '@/lib/types';
import { Async, Drawer, Empty, Field, KeyValue, Markdown, Modal, Panel, StatusBadge, Tabs } from '@/components/ui';
import { useToast } from '@/components/toast';

type IncidentDetail = Incident & {
  timeline: ProjectEvent[];
  healthChecks: { id: string; ok: boolean; httpStatus: number | null; latencyMs: number | null; error: string | null; checkedAt: string }[];
  remediations: { id: string; action: string; trigger: string; status: string; diagnosis: string | null; result: { recovered?: boolean; httpStatus?: number; latencyMs?: number; error?: string } | null; attempt: number; createdAt: string }[];
};

const SOURCE: Record<string, string> = { monitor: 'Sağlık izleme', deployment: 'Deployment', manual: 'Elle açıldı' };

/** Incidents (spec §106–108): opened by health monitoring, failed deployments or by hand; closed with a post-mortem. */
export default function IncidentsPage() {
  const slug = useProjectSlug();
  const params = useSearchParams();
  const router = useRouter();
  const project = useProject().data;
  const [creating, setCreating] = useState(false);
  const q = useQuery({ queryKey: ['incidents', slug], queryFn: () => api<Incident[]>(`/projects/${slug}/incidents`) });
  const canManage = !!project?.permissions.includes('environment.manage') && project.status !== 'archived';
  const openId = params.get('open');

  return (
    <>
      <div className="spread" style={{ marginBottom: 12 }}>
        <div>
          <h2 style={{ margin: 0 }}>Olaylar</h2>
          <p className="sub">Erişim kesintileri ve başarısız yayınlar. Her olay o andaki proje akışıyla birlikte saklanır; kapanışta post-mortem yazılır.</p>
        </div>
        {canManage && (
          <button className="btn" onClick={() => setCreating(true)}>
            <Plus /> Olay aç
          </button>
        )}
      </div>
      <Async q={q} rows={4}>
        {(rows) =>
          rows.length ? (
            <Panel flush>
              <div className="tbl">
                <table>
                  <thead>
                    <tr>
                      <th>No</th>
                      <th>Olay</th>
                      <th>Önem</th>
                      <th>Durum</th>
                      <th>Kaynak</th>
                      <th>Süre</th>
                      <th>Başlangıç</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((i) => (
                      <tr key={i.id} className="click" onClick={() => router.replace(`/projects/${slug}/incidents?open=${i.id}`)}>
                        <td className="mono small">{i.key}</td>
                        <td>
                          {i.title}
                          {i.environmentName && <div className="small muted">{i.environmentName}</div>}
                        </td>
                        <td>
                          <StatusBadge status={i.severity} />
                        </td>
                        <td>
                          <StatusBadge status={i.status} label={i.status === 'open' ? 'Açık' : 'Çözüldü'} />
                        </td>
                        <td className="small">{SOURCE[i.source] ?? i.source}</td>
                        <td className="small mono">{duration((i.resolvedAt ? new Date(i.resolvedAt).getTime() : Date.now()) - new Date(i.startedAt).getTime())}</td>
                        <td className="small muted">{ago(i.startedAt)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Panel>
          ) : (
            <Empty title="Olay yok">Sağlık izlemesi açık ortamlarda art arda 3 başarısız kontrol olay açar.</Empty>
          )
        }
      </Async>
      {openId && <IncidentDrawer id={openId} canManage={canManage} canAi={!!project?.permissions.includes('ai.execute')} onClose={() => router.replace(`/projects/${slug}/incidents`)} />}
      {creating && <OpenIncident slug={slug} onClose={() => setCreating(false)} onOpened={(id) => (setCreating(false), router.replace(`/projects/${slug}/incidents?open=${id}`))} />}
    </>
  );
}

function IncidentDrawer({ id, canManage, canAi, onClose }: { id: string; canManage: boolean; canAi: boolean; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [tab, setTab] = useState<'summary' | 'timeline' | 'postmortem'>('summary');
  const q = useQuery({ queryKey: ['incident', id], queryFn: () => api<IncidentDetail>(`/incidents/${id}`) });
  const [rootCause, setRootCause] = useState('');
  const [postmortem, setPostmortem] = useState('');
  const [editing, setEditing] = useState(false);
  useEffect(() => {
    if (q.data) {
      setRootCause(q.data.rootCause ?? '');
      setPostmortem(q.data.postmortem ?? '');
    }
  }, [q.data]);
  const save = useMutation({
    mutationFn: (body: Record<string, unknown>) => api<IncidentDetail>(`/incidents/${id}`, { method: 'PATCH', body }),
    onSuccess: (d) => {
      qc.setQueryData(['incident', id], d);
      void qc.invalidateQueries({ queryKey: ['incidents'] });
      setEditing(false);
      toast('Kaydedildi');
    },
    onError: (e) => toast(errorMessage(e), 'bad'),
  });
  const draft = useMutation({
    mutationFn: () => api<{ draft: string }>(`/incidents/${id}/postmortem-draft`, { method: 'POST' }),
    onSuccess: (r) => {
      setPostmortem(r.draft);
      setEditing(true);
      setTab('postmortem');
      toast('AI taslağı hazır; gözden geçirip kaydedin');
    },
    onError: (e) => toast(errorMessage(e), 'bad'),
  });
  const remediate = useMutation({
    mutationFn: () => api(`/incidents/${id}/remediations`, { method: 'POST' }),
    onSuccess: () => {
      toast('Düşük riskli sağlık kontrolü sıraya alındı');
      void qc.invalidateQueries({ queryKey: ['incident', id] });
    },
    onError: (e) => toast(errorMessage(e), 'bad'),
  });
  return (
    <Drawer title={q.data ? `${q.data.key} · ${q.data.title}` : 'Olay'} onClose={onClose} wide>
      <Async q={q}>
        {(i) => (
          <>
            <Tabs
              value={tab}
              onChange={setTab}
              items={[
                ['summary', 'Özet'],
                ['timeline', `O anki akış (${i.timeline.length})`],
                ['postmortem', 'Post-mortem'],
              ]}
            />
            {tab === 'summary' && (
              <>
                <KeyValue
                  items={[
                    ['Durum', <StatusBadge key="s" status={i.status} label={i.status === 'open' ? 'Açık' : 'Çözüldü'} />],
                    ['Önem', <StatusBadge key="v" status={i.severity} />],
                    ['Kaynak', SOURCE[i.source] ?? i.source],
                    ['Başlangıç', dateTime(i.startedAt)],
                    ['Çözülme', i.resolvedAt ? dateTime(i.resolvedAt) : '—'],
                    ['Süre', duration((i.resolvedAt ? new Date(i.resolvedAt).getTime() : Date.now()) - new Date(i.startedAt).getTime())],
                  ]}
                />
                <Field label="Kök neden" id="inc-rc">
                  <textarea id="inc-rc" className="in" value={rootCause} onChange={(e) => setRootCause(e.target.value)} disabled={!canManage} maxLength={5000} placeholder="Ne oldu, neden oldu?" />
                </Field>
                {canManage && (
                  <div className="row">
                    <button className="btn" onClick={() => save.mutate({ rootCause })} disabled={save.isPending || rootCause === (i.rootCause ?? '')}>
                      Kök nedeni kaydet
                    </button>
                    {i.status === 'open' ? (
                      <button className="btn pri" onClick={() => save.mutate({ status: 'resolved', rootCause })} disabled={save.isPending}>
                        Çözüldü olarak kapat
                      </button>
                    ) : (
                      <button className="btn" onClick={() => save.mutate({ status: 'open' })} disabled={save.isPending}>
                        Yeniden aç
                      </button>
                    )}
                    {canAi && i.status === 'open' && i.source === 'monitor' && (
                      <button className="btn" onClick={() => remediate.mutate()} disabled={remediate.isPending} title="Ayar ve acil durdurma politikası sunucuda yeniden doğrulanır">
                        {remediate.isPending ? <span className="spinner" /> : <RefreshCw />} Kontrollü sağlık kontrolü
                      </button>
                    )}
                  </div>
                )}
                {i.remediations.length > 0 && (
                  <>
                    <h3 style={{ margin: '18px 0 8px' }}>Kontrollü iyileştirme geçmişi</h3>
                    {i.remediations.map((r) => (
                      <div className="list-item" key={r.id}>
                        <StatusBadge status={r.status} />
                        <div style={{ flex: 1 }}>
                          <div className="small">Sağlık kontrolü · {r.trigger === 'automatic' ? 'otomatik' : 'elle'} · deneme {r.attempt}</div>
                          <div className="small muted">{r.diagnosis}{r.result ? ` · ${r.result.recovered ? 'erişim düzeldi' : 'erişim hâlâ başarısız'}${r.result.httpStatus ? ` · HTTP ${r.result.httpStatus}` : ''}` : ''}</div>
                        </div>
                        <span className="small muted">{ago(r.createdAt)}</span>
                      </div>
                    ))}
                  </>
                )}
                {i.healthChecks.length > 0 && (
                  <>
                    <h3 style={{ margin: '18px 0 8px' }}>Sağlık kontrolleri</h3>
                    <div className="tbl">
                      <table>
                        <tbody>
                          {i.healthChecks.slice(0, 20).map((c) => (
                            <tr key={c.id}>
                              <td className="small">{dateTime(c.checkedAt)}</td>
                              <td>{c.ok ? <StatusBadge status="healthy" /> : <StatusBadge status="down" />}</td>
                              <td className="mono small">{c.httpStatus ?? '—'}</td>
                              <td className="mono small">{c.latencyMs !== null ? `${c.latencyMs} ms` : '—'}</td>
                              <td className="small muted">{c.error}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </>
                )}
              </>
            )}
            {tab === 'timeline' &&
              (i.timeline.length ? (
                <div>
                  {i.timeline.map((e) => (
                    <div key={e.id} className="row" style={{ gap: 10, padding: '6px 0', borderBottom: '1px solid var(--line)', flexWrap: 'nowrap', alignItems: 'flex-start' }}>
                      <span className="mono small muted" style={{ minWidth: 44 }}>
                        {time(e.createdAt)}
                      </span>
                      <span className="small" style={{ color: EVENT_KIND[e.kind]?.[1], minWidth: 80 }}>
                        {EVENT_KIND[e.kind]?.[0] ?? e.kind}
                      </span>
                      <div style={{ minWidth: 0 }}>
                        <div style={{ fontSize: 13 }}>{e.title}</div>
                        {e.description && <div className="small muted">{e.description}</div>}
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <p className="small muted">Olay çevresinde (1 saat öncesinden itibaren) kayıtlı proje olayı yok.</p>
              ))}
            {tab === 'postmortem' && (
              <>
                {editing ? (
                  <>
                    <textarea className="in mono" style={{ minHeight: 360 }} value={postmortem} onChange={(e) => setPostmortem(e.target.value)} maxLength={50000} />
                    <div className="row" style={{ marginTop: 8 }}>
                      <button className="btn pri" onClick={() => save.mutate({ postmortem })} disabled={save.isPending}>
                        Kaydet
                      </button>
                      <button className="btn" onClick={() => (setEditing(false), setPostmortem(i.postmortem ?? ''))}>
                        Vazgeç
                      </button>
                    </div>
                  </>
                ) : i.postmortem ? (
                  <Markdown text={i.postmortem} />
                ) : (
                  <p className="small muted">Post-mortem yazılmadı. Zaman çizelgesi, etki, kök neden ve alınacak önlemleri içermeli.</p>
                )}
                {canManage && !editing && (
                  <div className="row" style={{ marginTop: 12 }}>
                    <button className="btn" onClick={() => setEditing(true)}>
                      {i.postmortem ? 'Düzenle' : 'Yaz'}
                    </button>
                    {canAi && (
                      <button className="btn pri" onClick={() => draft.mutate()} disabled={draft.isPending}>
                        {draft.isPending ? <span className="spinner" /> : <Bot />} AI taslak hazırlasın
                      </button>
                    )}
                  </div>
                )}
              </>
            )}
          </>
        )}
      </Async>
    </Drawer>
  );
}

function OpenIncident({ slug, onClose, onOpened }: { slug: string; onClose: () => void; onOpened: (id: string) => void }) {
  const envs = useQuery({ queryKey: ['environments', slug], queryFn: () => api<Environment[]>(`/projects/${slug}/environments`) });
  const [title, setTitle] = useState('');
  const [severity, setSeverity] = useState('high');
  const [environmentId, setEnvironmentId] = useState('');
  const open = useMutation({
    mutationFn: () => api<{ id: string }>(`/projects/${slug}/incidents`, { method: 'POST', body: { title, severity, environmentId: environmentId || null } }),
    onSuccess: (r) => onOpened(r.id),
  });
  return (
    <Modal
      title="Olay aç"
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            Vazgeç
          </button>
          <button className="btn danger solid" disabled={title.trim().length < 3 || open.isPending} onClick={() => open.mutate()}>
            Olay aç
          </button>
        </>
      }
    >
      <Field label="Başlık" id="oi-title">
        <input id="oi-title" className="in" value={title} onChange={(e) => setTitle(e.target.value)} maxLength={300} placeholder="ör. Ödeme sayfası 500 hatası veriyor" />
      </Field>
      <div className="grid g2">
        <Field label="Önem" id="oi-sev">
          <select id="oi-sev" className="in" value={severity} onChange={(e) => setSeverity(e.target.value)}>
            <option value="critical">Kritik</option>
            <option value="high">Yüksek</option>
            <option value="medium">Orta</option>
            <option value="low">Düşük</option>
          </select>
        </Field>
        <Field label="Ortam" id="oi-env">
          <select id="oi-env" className="in" value={environmentId} onChange={(e) => setEnvironmentId(e.target.value)}>
            <option value="">—</option>
            {envs.data?.map((e) => (
              <option key={e.id} value={e.id}>
                {e.name}
              </option>
            ))}
          </select>
        </Field>
      </div>
      {open.error && <div className="badbox">{errorMessage(open.error)}</div>}
    </Modal>
  );
}
