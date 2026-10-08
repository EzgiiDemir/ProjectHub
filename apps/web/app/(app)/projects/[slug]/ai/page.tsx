'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus } from 'lucide-react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useMemo, useState } from 'react';
import { api, errorMessage } from '@/lib/api';
import { ago } from '@/lib/format';
import { useProject, useProjectSlug } from '@/lib/hooks';
import { AI_LEVEL } from '@/lib/labels';
import type { AiTask, Citation } from '@/lib/types';
import { AiChat, AiNotConfigured, useAiStatus, type ChatTurn } from '@/components/ai-chat';
import { Async, Empty, Field, Modal, Panel, StatusBadge, Tabs } from '@/components/ui';

interface Conversation {
  id: string;
  title: string;
  updatedAt: string;
}

const SOURCE: Record<string, string> = { feedback: 'Geri bildirim', build: 'Build hatası', finding: 'Güvenlik bulgusu', manual: 'Elle' };

/** Project AI (spec §70–79): grounded Q&A and fix tasks that always end in a human decision. */
export default function AiPage() {
  const slug = useProjectSlug();
  const params = useSearchParams();
  const router = useRouter();
  const status = useAiStatus();
  const tab = (params.get('tab') as 'ask' | 'tasks') ?? 'ask';
  const conversationId = params.get('c');
  const set = (next: Record<string, string>) => {
    const sp = new URLSearchParams(params);
    for (const [k, v] of Object.entries(next)) v ? sp.set(k, v) : sp.delete(k);
    router.replace(`/projects/${slug}/ai?${sp}`);
  };

  return (
    <>
      <div className="spread" style={{ marginBottom: 6 }}>
        <div>
          <h2 style={{ margin: 0 }}>AI asistanı</h2>
          <p className="sub">
            {status.data?.configured ? (
              <>
                {status.data.provider} · {status.data.model} · Yetki: {AI_LEVEL[status.data.autonomyLevel] ?? status.data.autonomyLevel}. AI production&apos;a deploy etmez, kendi değişikliğini birleştiremez.
              </>
            ) : (
              'AI, kod indeksine ve proje geçmişine dayanarak cevap verir; düzeltmeleri ayrı bir branch’te önerir ve insan onayı bekler.'
            )}
          </p>
        </div>
      </div>
      {status.data && !status.data.configured && (
        <div style={{ marginBottom: 12 }}>
          <AiNotConfigured reason={status.data.reason} />
        </div>
      )}
      <Tabs
        value={tab}
        onChange={(t) => set({ tab: t, c: '' })}
        items={[
          ['ask', 'Soru sor'],
          ['tasks', 'AI görevleri'],
        ]}
      />
      {tab === 'ask' ? <Ask slug={slug} conversationId={conversationId} onConversation={(c) => set({ c })} /> : <Tasks slug={slug} />}
    </>
  );
}

function Ask({ slug, conversationId, onConversation }: { slug: string; conversationId: string | null; onConversation: (id: string) => void }) {
  const qc = useQueryClient();
  const list = useQuery({ queryKey: ['aiConversations', slug], queryFn: () => api<Conversation[]>(`/projects/${slug}/ai/conversations`) });
  const convo = useQuery({
    queryKey: ['aiConversation', conversationId],
    queryFn: () => api<Conversation & { messages: { role: 'user' | 'assistant'; content: string; citations: Citation[] | null }[] }>(`/ai/conversations/${conversationId}`),
    enabled: !!conversationId,
    staleTime: Infinity,
  });
  const turns: ChatTurn[] = useMemo(() => (convo.data?.messages ?? []).map((m) => ({ role: m.role, content: m.content, citations: m.citations ?? undefined })), [convo.data]);
  return (
    <div className="grid" style={{ gridTemplateColumns: '240px minmax(0, 1fr)', alignItems: 'stretch' }}>
      <Panel flush>
        <div style={{ padding: 8 }}>
          <button className={`btn sm ${!conversationId ? 'pri' : ''}`} style={{ width: '100%' }} onClick={() => onConversation('')}>
            <Plus /> Yeni konuşma
          </button>
        </div>
        <div className="dev-list" style={{ padding: '0 6px 6px' }}>
          {list.data?.map((c) => (
            <button key={c.id} className={conversationId === c.id ? 'on' : ''} onClick={() => onConversation(c.id)} title={c.title}>
              <span className="ellipsis" style={{ maxWidth: 150 }}>
                {c.title}
              </span>
              <span className="small muted">{ago(c.updatedAt)}</span>
            </button>
          ))}
          {list.data && !list.data.length && <p className="small muted" style={{ padding: 6 }}>Konuşma yok.</p>}
        </div>
      </Panel>
      <div className="panel flush" style={{ display: 'flex', flexDirection: 'column', height: 'calc(100vh - 290px)', minHeight: 480 }}>
        {conversationId && convo.isLoading ? (
          <div style={{ padding: 16 }}>
            <span className="spinner" />
          </div>
        ) : (
          <AiChat
            key={conversationId ?? 'new'}
            slug={slug}
            conversationId={conversationId}
            initialTurns={turns}
            onConversation={(id) => {
              void qc.invalidateQueries({ queryKey: ['aiConversations', slug] });
              onConversation(id);
            }}
            suggestions={['Bu proje nasıl çalışıyor, ana parçaları neler?', 'Son build neden başarısız oldu?', 'Açık müşteri geri bildirimlerini özetle', 'Production’daki sürümde neler var?', 'Güvenlik açısından en önemli risk ne?']}
          />
        )}
      </div>
    </div>
  );
}

function Tasks({ slug }: { slug: string }) {
  const router = useRouter();
  const project = useProject().data;
  const [creating, setCreating] = useState(false);
  const q = useQuery({
    queryKey: ['aiTasks', slug],
    queryFn: () => api<AiTask[]>(`/projects/${slug}/ai/tasks`),
    refetchInterval: (query) => ((query.state.data ?? []).some((t) => t.status === 'queued' || t.status === 'running') ? 3000 : false),
  });
  const canRun = !!project?.permissions.includes('ai.execute') && project.status !== 'archived';
  return (
    <>
      {canRun && (
        <div style={{ textAlign: 'right', marginBottom: 10 }}>
          <button className="btn pri" onClick={() => setCreating(true)}>
            <Plus /> Yeni AI görevi
          </button>
        </div>
      )}
      <Async q={q} rows={4}>
        {(rows) =>
          rows.length ? (
            <Panel flush>
              <div className="tbl">
                <table>
                  <thead>
                    <tr>
                      <th>No</th>
                      <th>Görev</th>
                      <th>Kaynak</th>
                      <th>Durum</th>
                      <th>Branch</th>
                      <th>Zaman</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((t) => (
                      <tr key={t.id} className="click" onClick={() => router.push(`/projects/${slug}/ai/tasks/${t.id}`)}>
                        <td className="mono small">{t.key}</td>
                        <td style={{ maxWidth: 380 }}>
                          <div className="ellipsis">{t.title}</div>
                          {t.result?.summary && <div className="small muted ellipsis">{t.result.summary}</div>}
                        </td>
                        <td className="small">{SOURCE[t.sourceType ?? 'manual']}</td>
                        <td>
                          <StatusBadge status={t.status} />
                        </td>
                        <td className="mono small">{t.branch ?? '—'}</td>
                        <td className="small muted">{ago(t.createdAt)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Panel>
          ) : (
            <Empty title="AI görevi yok">Başarısız build, müşteri geri bildirimi veya güvenlik bulgusundan “AI düzeltme önersin” ile ya da elle görev başlatabilirsiniz.</Empty>
          )
        }
      </Async>
      {creating && <NewTask slug={slug} onClose={() => setCreating(false)} />}
    </>
  );
}

function NewTask({ slug, onClose }: { slug: string; onClose: () => void }) {
  const router = useRouter();
  const [title, setTitle] = useState('');
  const [instruction, setInstruction] = useState('');
  const create = useMutation({
    mutationFn: () => api<AiTask>(`/projects/${slug}/ai/tasks`, { method: 'POST', body: { title, instruction, sourceType: 'manual' } }),
    onSuccess: (t) => router.push(`/projects/${slug}/ai/tasks/${t.id}`),
  });
  return (
    <Modal
      title="Yeni AI görevi"
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            Vazgeç
          </button>
          <button className="btn pri" disabled={!title.trim() || !instruction.trim() || create.isPending} onClick={() => create.mutate()}>
            {create.isPending && <span className="spinner" />} Başlat
          </button>
        </>
      }
    >
      <Field label="Başlık" id="ai-title">
        <input id="ai-title" className="in" value={title} onChange={(e) => setTitle(e.target.value)} maxLength={200} placeholder="ör. Ödeme butonunu mobilde büyüt" />
      </Field>
      <Field label="Talimat" id="ai-ins" hint="Ne değişmeli, nerede, kabul kriteri ne? AI değişikliği ayrı bir ai/ branch'inde hazırlar; birleştirme sizin onayınızla olur.">
        <textarea id="ai-ins" className="in" style={{ minHeight: 140 }} value={instruction} onChange={(e) => setInstruction(e.target.value)} maxLength={4000} />
      </Field>
      {create.error && <div className="badbox">{errorMessage(create.error)}</div>}
    </Modal>
  );
}
