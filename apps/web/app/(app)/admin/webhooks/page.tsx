'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus } from 'lucide-react';
import { useState } from 'react';
import { DOMAIN_EVENTS, type DomainEvent } from '@projecthub/contracts';
import { api, errorMessage } from '@/lib/api';
import { ago } from '@/lib/format';
import type { ProjectSummary } from '@/lib/types';
import { Async, ConfirmDialog, CopyButton, Drawer, Empty, Field, Modal, PageHeader, Panel, StatusBadge } from '@/components/ui';
import { useToast } from '@/components/toast';

interface Hook {
  id: string;
  url: string;
  events: DomainEvent[];
  projectId: string | null;
  active: boolean;
  createdAt: string;
}
interface Delivery {
  id: string;
  eventType: string;
  status: string;
  responseCode: number | null;
  error: string | null;
  durationMs: number | null;
  createdAt: string;
}

const EVENT_LABEL: Record<DomainEvent, string> = {
  'project.created': 'Proje oluşturuldu',
  'project.archived': 'Proje arşivlendi',
  'repository.pushed': 'Koda gönderim yapıldı',
  'pull_request.opened': 'Pull request açıldı',
  'pull_request.reviewed': 'Pull request incelendi',
  'pull_request.merged': 'Pull request birleştirildi',
  'build.completed': 'Build başarılı',
  'build.failed': 'Build başarısız',
  'preview.ready': 'Ön izleme hazır',
  'review.created': 'Kullanıcı linki oluşturuldu',
  'feedback.created': 'Geri bildirim geldi',
  'feedback.status_changed': 'Geri bildirim durumu değişti',
  'ai.task.awaiting_approval': 'AI önerisi onay bekliyor',
  'ai.task.merged': 'AI önerisi birleştirildi',
  'deployment.pending_approval': 'Deployment onay bekliyor',
  'deployment.succeeded': 'Deployment tamamlandı',
  'deployment.failed': 'Deployment başarısız',
  'deployment.rolled_back': 'Deployment geri alındı',
  'security.finding.critical': 'Kritik güvenlik bulgusu',
  'incident.opened': 'Olay açıldı',
  'incident.resolved': 'Olay çözüldü',
  'task.assigned': 'Görev atandı',
  'task.commented': 'Göreve yorum yapıldı',
  'project.mentioned': 'Tartışmada bahsedildi',
};

/** Outgoing webhooks (spec §123): signed JSON events for chat, ticketing or CI integrations. */
export default function WebhooksPage() {
  const [creating, setCreating] = useState(false);
  const [open, setOpen] = useState<Hook | null>(null);
  const [deleting, setDeleting] = useState<Hook | null>(null);
  const qc = useQueryClient();
  const toast = useToast();
  const q = useQuery({ queryKey: ['webhooks'], queryFn: () => api<Hook[]>('/admin/webhooks') });
  const projects = useQuery({ queryKey: ['projects', 'sidebar'], queryFn: () => api<ProjectSummary[]>('/projects?status=all') });
  const del = useMutation({
    mutationFn: (id: string) => api(`/admin/webhooks/${id}`, { method: 'DELETE' }),
    onSuccess: () => (toast('Webhook silindi'), setDeleting(null), void qc.invalidateQueries({ queryKey: ['webhooks'] })),
    onError: (e) => toast(errorMessage(e), 'bad'),
  });
  return (
    <div className="page">
      <PageHeader
        title="Webhook'lar"
        sub="Olaylar imzalı JSON olarak POST edilir: x-projecthub-event, x-projecthub-delivery ve x-projecthub-signature (sha256=HMAC) başlıklarıyla. Başarısız gönderimler tekrar denenir."
        actions={
          <button className="btn pri" onClick={() => setCreating(true)}>
            <Plus /> Webhook ekle
          </button>
        }
      />
      <Async q={q} rows={3}>
        {(rows) =>
          rows.length ? (
            <Panel flush>
              <div className="tbl">
                <table>
                  <thead>
                    <tr>
                      <th>Adres</th>
                      <th>Olaylar</th>
                      <th>Kapsam</th>
                      <th>Durum</th>
                      <th />
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((h) => (
                      <tr key={h.id} className="click" onClick={() => setOpen(h)}>
                        <td className="mono small">{h.url}</td>
                        <td className="small">{h.events.length === DOMAIN_EVENTS.length ? 'Tümü' : h.events.map((e) => EVENT_LABEL[e]).join(', ')}</td>
                        <td className="small">{h.projectId ? (projects.data?.find((p) => p.id === h.projectId)?.name ?? 'Proje') : 'Tüm projeler'}</td>
                        <td>{h.active ? <StatusBadge status="active" /> : <StatusBadge status="paused" />}</td>
                        <td style={{ textAlign: 'right' }} onClick={(e) => e.stopPropagation()}>
                          <button className="btn sm ghost" onClick={() => setDeleting(h)}>
                            Sil
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Panel>
          ) : (
            <Empty title="Webhook yok">Örneğin Slack/Teams köprüsüne “deployment başarısız” ve “kritik güvenlik bulgusu” olaylarını gönderebilirsiniz.</Empty>
          )
        }
      </Async>
      {creating && <CreateHook projects={projects.data ?? []} onClose={() => setCreating(false)} />}
      {open && <Deliveries hook={open} onClose={() => setOpen(null)} />}
      {deleting && <ConfirmDialog title="Webhook'u sil" message={deleting.url} actionLabel="Sil" busy={del.isPending} onConfirm={() => del.mutate(deleting.id)} onClose={() => setDeleting(null)} />}
    </div>
  );
}

function CreateHook({ projects, onClose }: { projects: ProjectSummary[]; onClose: () => void }) {
  const qc = useQueryClient();
  const [url, setUrl] = useState('');
  const [projectId, setProjectId] = useState('');
  const [events, setEvents] = useState<DomainEvent[]>(['deployment.failed', 'security.finding.critical', 'incident.opened']);
  const [secret, setSecret] = useState<string | null>(null);
  const create = useMutation({
    mutationFn: () => api<{ signingSecret: string }>('/admin/webhooks', { method: 'POST', body: { url, events, projectId: projectId || null, active: true } }),
    onSuccess: (r) => {
      setSecret(r.signingSecret);
      void qc.invalidateQueries({ queryKey: ['webhooks'] });
    },
  });
  return (
    <Modal
      title="Webhook ekle"
      wide
      onClose={onClose}
      footer={
        secret ? (
          <button className="btn pri" onClick={onClose}>
            Tamam
          </button>
        ) : (
          <>
            <button className="btn" onClick={onClose}>
              Vazgeç
            </button>
            <button className="btn pri" disabled={!/^https?:\/\/.+/.test(url) || !events.length || create.isPending} onClick={() => create.mutate()}>
              Ekle
            </button>
          </>
        )
      }
    >
      {secret ? (
        <div className="okbox">
          <div className="small" style={{ marginBottom: 6 }}>
            İmzalama anahtarı. Alıcı tarafta isteğin gövdesini bu anahtarla HMAC-SHA256 ile doğrulayın. Bir daha gösterilmez.
          </div>
          <div className="row" style={{ flexWrap: 'nowrap' }}>
            <code className="small ellipsis" style={{ flex: 1 }}>
              {secret}
            </code>
            <CopyButton text={secret} />
          </div>
        </div>
      ) : (
        <>
          <div className="grid g2">
            <Field label="Adres" id="wh-url">
              <input id="wh-url" className="in mono" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://…" />
            </Field>
            <Field label="Kapsam" id="wh-proj">
              <select id="wh-proj" className="in" value={projectId} onChange={(e) => setProjectId(e.target.value)}>
                <option value="">Tüm projeler</option>
                {projects.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
            </Field>
          </div>
          <div className="field">
            <label>Olaylar</label>
            <div className="grid g2" style={{ gap: 0 }}>
              {DOMAIN_EVENTS.map((e) => (
                <label key={e} className="check">
                  <input type="checkbox" checked={events.includes(e)} onChange={(x) => setEvents((list) => (x.target.checked ? [...list, e] : list.filter((y) => y !== e)))} />
                  {EVENT_LABEL[e]}
                </label>
              ))}
            </div>
          </div>
          {create.error && <div className="badbox">{errorMessage(create.error)}</div>}
        </>
      )}
    </Modal>
  );
}

function Deliveries({ hook, onClose }: { hook: Hook; onClose: () => void }) {
  const q = useQuery({ queryKey: ['webhookDeliveries', hook.id], queryFn: () => api<Delivery[]>(`/admin/webhooks/${hook.id}/deliveries`), refetchInterval: 10_000 });
  return (
    <Drawer title="Gönderimler" onClose={onClose} wide>
      <p className="mono small" style={{ marginTop: 0 }}>
        {hook.url}
      </p>
      <Async q={q}>
        {(rows) =>
          rows.length ? (
            <div className="tbl">
              <table>
                <tbody>
                  {rows.map((d) => (
                    <tr key={d.id}>
                      <td className="small muted">{ago(d.createdAt)}</td>
                      <td className="small">{EVENT_LABEL[d.eventType as DomainEvent] ?? d.eventType}</td>
                      <td>
                        <StatusBadge status={d.status === 'delivered' ? 'succeeded' : d.status} label={d.status === 'delivered' ? 'İletildi' : undefined} />
                      </td>
                      <td className="mono small">{d.responseCode ?? '—'}</td>
                      <td className="mono small">{d.durationMs !== null ? `${d.durationMs} ms` : ''}</td>
                      <td className="small" style={{ color: 'var(--bad)' }}>
                        {d.error}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <p className="small muted">Henüz gönderim yok.</p>
          )
        }
      </Async>
    </Drawer>
  );
}
