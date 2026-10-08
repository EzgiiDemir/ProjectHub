'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Bot, ListTodo } from 'lucide-react';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useState } from 'react';
import type { FeedbackStatus } from '@projecthub/contracts';
import { api, errorMessage } from '@/lib/api';
import { ago, dateTime } from '@/lib/format';
import { useDirectory, useProject, useProjectSlug } from '@/lib/hooks';
import { FEEDBACK_TYPE, PRIORITY, statusLabel } from '@/lib/labels';
import type { Feedback } from '@/lib/types';
import { Async, Badge, Field, KeyValue, Modal, Panel, StatusBadge } from '@/components/ui';
import { useToast } from '@/components/toast';

const STATUSES: FeedbackStatus[] = ['open', 'triaged', 'planned', 'in_progress', 'ready_for_review', 'resolved', 'rejected'];

export default function FeedbackDetailPage() {
  const { feedbackId } = useParams<{ feedbackId: string }>();
  const slug = useProjectSlug();
  const router = useRouter();
  const toast = useToast();
  const qc = useQueryClient();
  const project = useProject().data;
  const directory = useDirectory();
  const [comment, setComment] = useState('');
  const [taskOpen, setTaskOpen] = useState(false);
  const q = useQuery({ queryKey: ['feedbackItem', feedbackId], queryFn: () => api<Feedback>(`/feedback/${feedbackId}`) });
  const can = (p: 'feedback.manage' | 'ai.execute') => !!project?.permissions.includes(p);
  const refresh = (f?: Feedback) => {
    if (f) qc.setQueryData(['feedbackItem', feedbackId], f);
    else void qc.invalidateQueries({ queryKey: ['feedbackItem', feedbackId] });
    void qc.invalidateQueries({ queryKey: ['feedback'] });
  };
  const update = useMutation({
    mutationFn: (body: Record<string, unknown>) => api<Feedback>(`/feedback/${feedbackId}`, { method: 'PATCH', body }),
    onSuccess: (f) => (refresh(f), toast('Güncellendi')),
    onError: (e) => toast(errorMessage(e), 'bad'),
  });
  const addComment = useMutation({
    mutationFn: () => api(`/feedback/${feedbackId}/comments`, { method: 'POST', body: { body: comment } }),
    onSuccess: () => (setComment(''), refresh()),
    onError: (e) => toast(errorMessage(e), 'bad'),
  });
  const aiFix = useMutation({
    mutationFn: () => api<{ id: string }>(`/projects/${slug}/feedback/${feedbackId}/ai-fix`, { method: 'POST', body: {} }),
    onSuccess: (t) => router.push(`/projects/${slug}/ai/tasks/${t.id}`),
    onError: (e) => toast(errorMessage(e), 'bad'),
  });

  return (
    <Async q={q} rows={6}>
      {(f) => {
        const screenshot = f.attachments?.find((a) => a.kind === 'screenshot');
        return (
          <>
            <div className="spread" style={{ marginBottom: 12 }}>
              <div style={{ minWidth: 0 }}>
                <div className="small muted">
                  <Link href={`/projects/${slug}/feedback`}>Geri bildirimler</Link> / {f.key}
                </div>
                <h2 style={{ margin: '2px 0 4px' }}>{f.title}</h2>
                <div className="row" style={{ gap: 6 }}>
                  <Badge tone={f.type === 'bug' ? 'bad' : f.type === 'change_request' ? 'amber' : 'idle'}>{FEEDBACK_TYPE[f.type]}</Badge>
                  <StatusBadge status={f.status} label={f.statusLabel} />
                  <StatusBadge status={f.priority} label={`Öncelik: ${PRIORITY[f.priority]}`} />
                  {f.taskKey && <span className="tag">{f.taskKey}</span>}
                </div>
              </div>
              <div className="row">
                {can('feedback.manage') && !f.taskId && (
                  <button className="btn" onClick={() => setTaskOpen(true)}>
                    <ListTodo /> Göreve dönüştür
                  </button>
                )}
                {can('ai.execute') && f.status !== 'resolved' && f.status !== 'rejected' && (
                  <button className="btn pri" onClick={() => aiFix.mutate()} disabled={aiFix.isPending}>
                    <Bot /> AI düzeltme önersin
                  </button>
                )}
              </div>
            </div>
            <div className="grid" style={{ gridTemplateColumns: 'minmax(0, 1fr) 320px', alignItems: 'start' }}>
              <div className="grid" style={{ gap: 14 }}>
                <Panel title="Açıklama">
                  {f.body ? <div style={{ whiteSpace: 'pre-wrap', fontSize: 14 }}>{f.body}</div> : <p className="muted small" style={{ margin: 0 }}>Açıklama girilmedi.</p>}
                </Panel>
                {screenshot ? (
                  <Panel title="Ekran görüntüsü">
                    <a href={`/api/v1/artifacts/${screenshot.artifactId}/content`} target="_blank" rel="noreferrer">
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img src={`/api/v1/artifacts/${screenshot.artifactId}/content`} alt={`${f.key} ekran görüntüsü`} style={{ maxWidth: '100%', maxHeight: 640, border: '1px solid var(--line)', borderRadius: 6 }} />
                    </a>
                    <p className="small muted" style={{ margin: '6px 0 0' }}>İşaretlenen nokta görüntü üzerinde gösterilir. Görüntü, geri bildirim anındaki sürümden alınır.</p>
                  </Panel>
                ) : (
                  f.previewId && <div className="small muted">Ekran görüntüsü hazırlanıyor veya alınamadı.</div>
                )}
                {f.triage && (
                  <Panel title={<span className="row" style={{ gap: 6 }}><Bot size={16} /> AI ön değerlendirme</span>}>
                    <div className="ai-note">
                      <div>{f.triage.summary}</div>
                      <div className="small" style={{ marginTop: 6 }}>
                        Kategori: <b>{f.triage.category}</b> · Önem: <b>{statusLabel(f.triage.severity)}</b>
                      </div>
                    </div>
                  </Panel>
                )}
                {f.relatedFiles.length > 0 && (
                  <Panel title="İlgili olabilecek dosyalar" flush>
                    {f.relatedFiles.map((r) => (
                      <Link key={`${r.path}:${r.line}`} className="list-item" href={`/projects/${slug}/code?path=${encodeURIComponent(r.path)}&line=${r.line}`}>
                        <div style={{ minWidth: 0 }}>
                          <div className="mono small">
                            {r.path}:{r.line}
                          </div>
                          <div className="mono small muted ellipsis">{r.snippet}</div>
                        </div>
                      </Link>
                    ))}
                  </Panel>
                )}
                <Panel title="Yorumlar">
                  {f.comments?.length ? (
                    f.comments.map((c) => (
                      <div key={c.id} style={{ padding: '8px 0', borderBottom: '1px solid var(--line)' }}>
                        <div className="small">
                          <b>{c.author}</b>{' '}
                          <span className="muted">
                            {c.authorType === 'customer' ? 'müşteri' : c.authorType === 'system' ? 'sistem' : c.authorType === 'ai' ? 'AI' : 'ekip'} · {ago(c.createdAt)}
                          </span>
                        </div>
                        <div style={{ whiteSpace: 'pre-wrap', fontSize: 13.5 }}>{c.body}</div>
                      </div>
                    ))
                  ) : (
                    <p className="small muted">Henüz yorum yok.</p>
                  )}
                  <form
                    style={{ marginTop: 10 }}
                    onSubmit={(e) => {
                      e.preventDefault();
                      if (comment.trim()) addComment.mutate();
                    }}
                  >
                    <textarea className="in" value={comment} onChange={(e) => setComment(e.target.value)} placeholder="Yorum yazın. Müşteri linkten bu yorumları görür." maxLength={5000} />
                    <div style={{ textAlign: 'right', marginTop: 6 }}>
                      <button className="btn pri" disabled={!comment.trim() || addComment.isPending}>
                        Yorum ekle
                      </button>
                    </div>
                  </form>
                </Panel>
              </div>
              <div className="grid" style={{ gap: 14 }}>
                {can('feedback.manage') && (
                  <Panel title="Yönetim">
                    <Field label="Durum" id="fb-status" hint={f.status === 'ready_for_review' ? 'Müşteri linkten onaylayınca çözülür.' : undefined}>
                      <select id="fb-status" className="in" value={f.status} onChange={(e) => update.mutate({ status: e.target.value })} disabled={update.isPending}>
                        {STATUSES.map((s) => (
                          <option key={s} value={s}>
                            {statusLabel(s)}
                          </option>
                        ))}
                      </select>
                    </Field>
                    <Field label="Öncelik" id="fb-prio">
                      <select id="fb-prio" className="in" value={f.priority} onChange={(e) => update.mutate({ priority: e.target.value })} disabled={update.isPending}>
                        {Object.entries(PRIORITY).map(([k, l]) => (
                          <option key={k} value={k}>
                            {l}
                          </option>
                        ))}
                      </select>
                    </Field>
                    <Field label="Atanan" id="fb-asg">
                      <select id="fb-asg" className="in" value={f.assignee?.id ?? ''} onChange={(e) => update.mutate({ assignedUserId: e.target.value || null })} disabled={update.isPending}>
                        <option value="">Atanmadı</option>
                        {directory.data?.map((u) => (
                          <option key={u.id} value={u.id}>
                            {u.displayName}
                          </option>
                        ))}
                      </select>
                    </Field>
                  </Panel>
                )}
                <Panel title="Bağlam">
                  <KeyValue
                    items={[
                      ['Bildiren', <span key="r">{f.reporter.name}{f.reporter.department && <> <span className="dept">{f.reporter.department}</span></>}{f.reporter.company && <div className="small muted">{f.reporter.company}</div>}</span>],
                      ['Sayfa', <a key="u" className="mono small" href={f.pageUrl} target="_blank" rel="noreferrer">{f.pageUrl}</a>],
                      ['Ekran', f.viewport ? `${f.viewport.width}×${f.viewport.height}${f.deviceKey ? ` · ${f.deviceKey}` : ''}` : '—'],
                      ['Tarayıcı', [f.browser, f.operatingSystem].filter(Boolean).join(' · ') || '—'],
                      ['Öğe', f.domSelector ? <code key="d" className="small">{f.domSelector}</code> : '—'],
                      ['Konum', f.x !== null ? `x ${f.x}, y ${f.y} (kaydırma ${f.scrollY})` : '—'],
                      ['Sürüm', f.versionLabel ?? '—'],
                      ['Müşteri linki', f.reviewKey ? <Link key="rv" href={`/projects/${slug}/reviews?open=${f.reviewSessionId}`}>{f.reviewKey}</Link> : 'ekip içi'],
                      ['Görev', f.taskKey ? <Link key="t" href={`/projects/${slug}/tasks`}>{f.taskKey}</Link> : '—'],
                      ['Oluşturulma', dateTime(f.createdAt)],
                      ['Çözülme', f.resolvedAt ? dateTime(f.resolvedAt) : '—'],
                    ]}
                  />
                </Panel>
              </div>
            </div>
            {taskOpen && <ToTask feedback={f} onClose={() => setTaskOpen(false)} onDone={() => (setTaskOpen(false), refresh())} />}
          </>
        );
      }}
    </Async>
  );
}

function ToTask({ feedback: f, onClose, onDone }: { feedback: Feedback; onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const directory = useDirectory();
  const [title, setTitle] = useState(f.triage?.suggestedTitle ?? f.title);
  const [assignee, setAssignee] = useState(f.assignee?.id ?? '');
  const [hotfix, setHotfix] = useState(f.priority === 'critical');
  const create = useMutation({
    mutationFn: () => api<{ key: string; branch: string | null }>(`/feedback/${f.id}/task`, { method: 'POST', body: { title, assigneeId: assignee || null, hotfix } }),
    onSuccess: (r) => {
      toast(`${r.key} oluşturuldu${r.branch ? ` · ${r.branch}` : ''}`);
      onDone();
    },
  });
  return (
    <Modal
      title="Göreve dönüştür"
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            Vazgeç
          </button>
          <button className="btn pri" disabled={!title.trim() || create.isPending} onClick={() => create.mutate()}>
            Görev oluştur
          </button>
        </>
      }
    >
      <Field label="Başlık" id="t-title">
        <input id="t-title" className="in" value={title} onChange={(e) => setTitle(e.target.value)} maxLength={200} />
      </Field>
      <Field label="Atanan" id="t-asg">
        <select id="t-asg" className="in" value={assignee} onChange={(e) => setAssignee(e.target.value)}>
          <option value="">Atanmadı</option>
          {directory.data?.map((u) => (
            <option key={u.id} value={u.id}>
              {u.displayName}
            </option>
          ))}
        </select>
      </Field>
      <label className="check" style={{ alignItems: 'flex-start' }}>
        <input type="checkbox" checked={hotfix} onChange={(e) => setHotfix(e.target.checked)} />
        <span>
          Hotfix
          <div className="small muted">Varsayılan branch&apos;ten bir hotfix branch&apos;i açılır.</div>
        </span>
      </label>
      {create.error && <div className="badbox">{errorMessage(create.error)}</div>}
    </Modal>
  );
}
