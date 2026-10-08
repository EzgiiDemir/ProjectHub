'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus } from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';
import type { TaskStatus } from '@projecthub/contracts';
import { api, errorMessage } from '@/lib/api';
import { ago } from '@/lib/format';
import { useDirectory, useProject, useProjectSlug } from '@/lib/hooks';
import { PRIORITY, statusLabel } from '@/lib/labels';
import type { Task } from '@/lib/types';
import { Async, Avatar, Badge, Drawer, Field, StatusBadge } from '@/components/ui';
import { useToast } from '@/components/toast';

const COLUMNS: TaskStatus[] = ['todo', 'in_progress', 'in_review', 'done'];

/** Work items created from feedback, AI suggestions or by hand (spec §64, §103). */
export default function TasksPage() {
  const slug = useProjectSlug();
  const project = useProject().data;
  const [editing, setEditing] = useState<Task | 'new' | null>(null);
  const [showCancelled, setShowCancelled] = useState(false);
  const q = useQuery({ queryKey: ['tasks', slug], queryFn: () => api<Task[]>(`/projects/${slug}/tasks`) });
  const canEdit = !!project?.permissions.includes('feedback.manage') && project.status !== 'archived';

  return (
    <>
      <div className="spread" style={{ marginBottom: 12 }}>
        <div>
          <h2 style={{ margin: 0 }}>Görevler</h2>
          <p className="sub">Geri bildirimden, AI önerisinden veya elle oluşturulan işler.</p>
        </div>
        <div className="row">
          <label className="check small">
            <input type="checkbox" checked={showCancelled} onChange={(e) => setShowCancelled(e.target.checked)} /> İptal edilenleri göster
          </label>
          {canEdit && (
            <button className="btn pri" onClick={() => setEditing('new')}>
              <Plus /> Görev ekle
            </button>
          )}
        </div>
      </div>
      <Async q={q} rows={4}>
        {(rows) => (
          <div className="grid g4" style={{ alignItems: 'start' }}>
            {[...COLUMNS, ...(showCancelled ? (['cancelled'] as TaskStatus[]) : [])].map((col) => {
              const items = rows.filter((t) => t.status === col);
              return (
                <div key={col} className="panel" style={{ padding: 10, background: 'var(--sunk2)' }}>
                  <div className="spread" style={{ marginBottom: 8 }}>
                    <b style={{ fontSize: 13 }}>{statusLabel(col)}</b>
                    <span className="small muted">{items.length}</span>
                  </div>
                  <div className="grid" style={{ gap: 8 }}>
                    {items.map((t) => (
                      <button key={t.id} className="panel" style={{ padding: 10, textAlign: 'left', cursor: 'pointer', font: 'inherit', color: 'inherit', width: '100%' }} onClick={() => setEditing(t)}>
                        <div className="spread small">
                          <span className="mono muted">{t.key}</span>
                          {t.isHotfix && <Badge tone="bad" plain>Hotfix</Badge>}
                        </div>
                        <div style={{ fontSize: 13.5, margin: '4px 0 6px' }}>{t.title}</div>
                        <div className="spread small">
                          <StatusBadge status={t.priority} label={PRIORITY[t.priority]} />
                          {t.assignee ? <Avatar name={t.assignee.displayName} color={t.assignee.avatarColor} size={22} /> : <span className="muted">atanmadı</span>}
                        </div>
                        {t.branch && <div className="tag" style={{ marginTop: 6, display: 'inline-block' }}>{t.branch}</div>}
                      </button>
                    ))}
                    {!items.length && <div className="small muted" style={{ padding: 6 }}>Boş</div>}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </Async>
      {editing && <TaskDrawer slug={slug} task={editing === 'new' ? null : editing} canEdit={canEdit} onClose={() => setEditing(null)} />}
    </>
  );
}

function TaskDrawer({ slug, task, canEdit, onClose }: { slug: string; task: Task | null; canEdit: boolean; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const directory = useDirectory();
  const [title, setTitle] = useState(task?.title ?? '');
  const [description, setDescription] = useState(task?.description ?? '');
  const [priority, setPriority] = useState(task?.priority ?? 'medium');
  const [status, setStatus] = useState<TaskStatus>(task?.status ?? 'todo');
  const [assigneeId, setAssigneeId] = useState(task?.assignee?.id ?? '');
  const save = useMutation({
    mutationFn: () =>
      task
        ? api(`/tasks/${task.id}`, { method: 'PATCH', body: { title, description, priority, status, assigneeId: assigneeId || null } })
        : api(`/projects/${slug}/tasks`, { method: 'POST', body: { title, description, priority, assigneeId: assigneeId || null } }),
    onSuccess: () => {
      toast(task ? 'Görev güncellendi' : 'Görev oluşturuldu');
      void qc.invalidateQueries({ queryKey: ['tasks'] });
      onClose();
    },
  });
  return (
    <Drawer
      title={task ? `${task.key} · ${task.title}` : 'Yeni görev'}
      onClose={onClose}
      footer={
        canEdit && (
          <>
            <button className="btn" onClick={onClose}>
              Vazgeç
            </button>
            <button className="btn pri" disabled={!title.trim() || save.isPending} onClick={() => save.mutate()}>
              Kaydet
            </button>
          </>
        )
      }
    >
      <fieldset disabled={!canEdit} style={{ border: 0, padding: 0, margin: 0 }}>
        <Field label="Başlık" id="tk-title">
          <input id="tk-title" className="in" value={title} onChange={(e) => setTitle(e.target.value)} maxLength={200} />
        </Field>
        <Field label="Açıklama" id="tk-desc">
          <textarea id="tk-desc" className="in" style={{ minHeight: 160 }} value={description} onChange={(e) => setDescription(e.target.value)} maxLength={10000} />
        </Field>
        <div className="grid g2">
          {task && (
            <Field label="Durum" id="tk-status">
              <select id="tk-status" className="in" value={status} onChange={(e) => setStatus(e.target.value as TaskStatus)}>
                {[...COLUMNS, 'cancelled' as const].map((s) => (
                  <option key={s} value={s}>
                    {statusLabel(s)}
                  </option>
                ))}
              </select>
            </Field>
          )}
          <Field label="Öncelik" id="tk-prio">
            <select id="tk-prio" className="in" value={priority} onChange={(e) => setPriority(e.target.value)}>
              {Object.entries(PRIORITY).map(([k, l]) => (
                <option key={k} value={k}>
                  {l}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Atanan" id="tk-asg">
            <select id="tk-asg" className="in" value={assigneeId} onChange={(e) => setAssigneeId(e.target.value)}>
              <option value="">Atanmadı</option>
              {directory.data?.map((u) => (
                <option key={u.id} value={u.id}>
                  {u.displayName}
                </option>
              ))}
            </select>
          </Field>
        </div>
      </fieldset>
      {task && (
        <div className="small muted" style={{ marginTop: 8 }}>
          {task.sourceType === 'feedback' && task.sourceId && (
            <div>
              Kaynak: <Link href={`/projects/${slug}/feedback/${task.sourceId}`}>geri bildirim</Link>
            </div>
          )}
          {task.branch && (
            <div>
              Branch: <Link href={`/projects/${slug}/git?branch=${encodeURIComponent(task.branch)}`} className="mono">{task.branch}</Link>
            </div>
          )}
          <div>Oluşturulma: {ago(task.createdAt)}</div>
        </div>
      )}
      {save.error && <div className="badbox" style={{ marginTop: 10 }}>{errorMessage(save.error)}</div>}
    </Drawer>
  );
}
