'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Database, Pencil, Plus, RefreshCw, Trash2 } from 'lucide-react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useMemo, useState } from 'react';
import { api, errorMessage } from '@/lib/api';
import { ago } from '@/lib/format';
import { useProject, useProjectSlug } from '@/lib/hooks';
import { AI_LEVEL } from '@/lib/labels';
import type { AiTask, Citation } from '@/lib/types';
import { AiChat, AiNotConfigured, useAiStatus, type ChatTurn } from '@/components/ai-chat';
import { Async, Empty, Field, Modal, Panel, StatusBadge, Tabs } from '@/components/ui';
import { useToast } from '@/components/toast';

interface Conversation {
  id: string;
  title: string;
  updatedAt: string;
}

interface AiMemory {
  id: string;
  category: 'architecture' | 'decision' | 'convention' | 'bug' | 'task_outcome' | 'fact';
  title: string;
  content: string;
  verification: 'verified' | 'inferred' | 'historical';
  sourceType: string;
  sourceRef: string | null;
  sourceLabel: string | null;
  updatedAt: string;
}

interface MemoryData {
  memories: AiMemory[];
  index: { files: number; chunks: number; indexedCommit: string | null; headCommit: string | null; upToDate: boolean; updatedAt: string | null; languages: { language: string; files: number }[] };
  canManage: boolean;
  canReindex: boolean;
}

const SOURCE: Record<string, string> = { feedback: 'Geri bildirim', build: 'Build hatası', finding: 'Güvenlik bulgusu', manual: 'Elle' };

/** Project AI (spec §70–79): grounded Q&A and fix tasks that always end in a human decision. */
export default function AiPage() {
  const slug = useProjectSlug();
  const params = useSearchParams();
  const router = useRouter();
  const status = useAiStatus();
  const tab = (params.get('tab') as 'ask' | 'tasks' | 'memory') ?? 'ask';
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
      {status.data && !status.data.configured && tab === 'tasks' && (
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
          ['memory', 'Proje hafızası'],
        ]}
      />
      {tab === 'ask' ? <Ask slug={slug} conversationId={conversationId} onConversation={(c) => set({ c })} /> : tab === 'tasks' ? <Tasks slug={slug} /> : <Memory slug={slug} highlighted={params.get('memory')} />}
    </>
  );
}

const MEMORY_CATEGORY: Record<AiMemory['category'], string> = {
  architecture: 'Mimari',
  decision: 'Karar',
  convention: 'Kural',
  bug: 'Bilinen hata',
  task_outcome: 'Görev sonucu',
  fact: 'Doğrulanmış bilgi',
};
const MEMORY_VERIFICATION: Record<AiMemory['verification'], string> = { verified: 'Doğrulandı', inferred: 'Çıkarım', historical: 'Geçmiş bilgi' };

function Memory({ slug, highlighted }: { slug: string; highlighted: string | null }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [editing, setEditing] = useState<AiMemory | 'new' | null>(null);
  const q = useQuery({ queryKey: ['aiMemory', slug], queryFn: () => api<MemoryData>(`/projects/${slug}/ai/memory`) });
  const reindex = useMutation({
    mutationFn: () => api(`/projects/${slug}/ai/reindex`, { method: 'POST', body: {} }),
    onSuccess: () => {
      toast('Yeniden indeksleme kuyruğa alındı');
      window.setTimeout(() => void q.refetch(), 1500);
    },
  });
  const remove = useMutation({
    mutationFn: (id: string) => api(`/projects/${slug}/ai/memory/${id}/delete`, { method: 'POST', body: {} }),
    onSuccess: () => {
      toast('Hafıza kaydı silindi');
      void qc.invalidateQueries({ queryKey: ['aiMemory', slug] });
    },
  });
  return (
    <Async q={q} rows={5}>
      {(data) => (
        <>
          <Panel
            title="İndeks durumu"
            actions={data.canReindex ? <button className="btn sm" disabled={reindex.isPending} onClick={() => reindex.mutate()}><RefreshCw /> Yeniden indeksle</button> : undefined}
          >
            <div className="grid g4">
              <div><b className="mono">{data.index.files}</b><div className="small muted">Dosya</div></div>
              <div><b className="mono">{data.index.chunks}</b><div className="small muted">Arama parçası</div></div>
              <div><b className="mono">{data.index.indexedCommit?.slice(0, 7) ?? '—'}</b><div className="small muted">İndekslenen commit</div></div>
              <div><StatusBadge status={data.index.upToDate ? 'completed' : 'warning'} /><div className="small muted">{data.index.upToDate ? 'Güncel' : 'Yenileme gerekli'}</div></div>
            </div>
            {!!data.index.languages.length && <div className="small muted mt">{data.index.languages.map((item) => `${item.language}: ${item.files}`).join(' · ')}</div>}
          </Panel>
          <Panel title="Kalıcı proje bilgisi" className="mt" actions={data.canManage ? <button className="btn sm pri" onClick={() => setEditing('new')}><Plus /> Bilgi ekle</button> : undefined}>
            {data.memories.length ? (
              <div className="stack">
                {data.memories.map((memory) => (
                  <article key={memory.id} className={`card ${highlighted === memory.id ? 'selected' : ''}`} id={`memory-${memory.id}`}>
                    <div className="spread">
                      <div>
                        <div className="row"><Database size={15} /><b>{memory.title}</b><StatusBadge status={memory.verification === 'verified' ? 'completed' : memory.verification === 'inferred' ? 'warning' : 'idle'} /></div>
                        <div className="small muted">{MEMORY_CATEGORY[memory.category]} · {MEMORY_VERIFICATION[memory.verification]} · {memory.sourceLabel ?? memory.sourceType} · {ago(memory.updatedAt)}</div>
                      </div>
                      {data.canManage && (
                        <div className="row">
                          <button className="icon-btn" title="Düzelt" onClick={() => setEditing(memory)}><Pencil /></button>
                          <button className="icon-btn" title="Sil" disabled={remove.isPending} onClick={() => { if (window.confirm('Bu proje hafızası kaydı silinsin mi?')) remove.mutate(memory.id); }}><Trash2 /></button>
                        </div>
                      )}
                    </div>
                    <p className="small" style={{ whiteSpace: 'pre-wrap', marginBottom: 0 }}>{memory.content}</p>
                  </article>
                ))}
              </div>
            ) : <Empty title="Proje hafızası boş">İndeksleme mimari bir özet oluşturur; yetkili kullanıcılar doğrulanmış karar ve kuralları buraya ekleyebilir.</Empty>}
          </Panel>
          {editing && <MemoryEditor slug={slug} memory={editing === 'new' ? null : editing} onClose={() => setEditing(null)} />}
        </>
      )}
    </Async>
  );
}

function MemoryEditor({ slug, memory, onClose }: { slug: string; memory: AiMemory | null; onClose: () => void }) {
  const qc = useQueryClient();
  const [category, setCategory] = useState<AiMemory['category']>(memory?.category ?? 'decision');
  const [verification, setVerification] = useState<AiMemory['verification']>(memory?.verification ?? 'verified');
  const [title, setTitle] = useState(memory?.title ?? '');
  const [content, setContent] = useState(memory?.content ?? '');
  const save = useMutation({
    mutationFn: () => api(memory ? `/projects/${slug}/ai/memory/${memory.id}` : `/projects/${slug}/ai/memory`, { method: memory ? 'PATCH' : 'POST', body: { category, verification, title, content } }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['aiMemory', slug] });
      onClose();
    },
  });
  return (
    <Modal title={memory ? 'Hafıza kaydını düzelt' : 'Proje bilgisi ekle'} onClose={onClose} footer={<><button className="btn" onClick={onClose}>Vazgeç</button><button className="btn pri" disabled={!title.trim() || !content.trim() || save.isPending} onClick={() => save.mutate()}>Kaydet</button></>}>
      <div className="grid g2">
        <Field label="Kategori" id="memory-category"><select id="memory-category" className="in" value={category} onChange={(e) => setCategory(e.target.value as AiMemory['category'])}>{Object.entries(MEMORY_CATEGORY).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></Field>
        <Field label="Doğrulama" id="memory-verification"><select id="memory-verification" className="in" value={verification} onChange={(e) => setVerification(e.target.value as AiMemory['verification'])}>{Object.entries(MEMORY_VERIFICATION).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></Field>
      </div>
      <Field label="Başlık" id="memory-title"><input id="memory-title" className="in" value={title} onChange={(e) => setTitle(e.target.value)} maxLength={200} /></Field>
      <Field label="Bilgi" id="memory-content" hint="Yalnızca kaynağı bilinen, projeye özgü ve gelecekte yararlı bilgileri saklayın."><textarea id="memory-content" className="in" style={{ minHeight: 180 }} value={content} onChange={(e) => setContent(e.target.value)} maxLength={20000} /></Field>
      {save.error && <div className="badbox">{errorMessage(save.error)}</div>}
    </Modal>
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
            suggestions={['Bu proje nasıl çalışıyor, ana parçaları neler?', 'Son build neden başarısız oldu?', 'Açık kullanıcı geri bildirimlerini özetle', 'Production’daki sürümde neler var?', 'Güvenlik açısından en önemli risk ne?']}
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
            <Empty title="AI görevi yok">Başarısız build, kullanıcı geri bildirimi veya güvenlik bulgusundan “AI düzeltme önersin” ile ya da elle görev başlatabilirsiniz.</Empty>
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
  const [type, setType] = useState('fix');
  const create = useMutation({
    mutationFn: () => api<AiTask>(`/projects/${slug}/ai/tasks`, { method: 'POST', body: { title, instruction, type, sourceType: 'manual' } }),
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
      <Field label="İş akışı" id="ai-type" hint="Analiz akışları salt okunurdur; kod, test ve dokümantasyon üretimi ayrı AI branch’inde onaya sunulur.">
        <select id="ai-type" className="in" value={type} onChange={(e) => setType(e.target.value)}>
          <option value="fix">Kod geliştirme / hata düzeltme</option>
          <option value="test_generation">Test üretme</option>
          <option value="docs">Dokümantasyon üretme</option>
          <option value="architecture_review">Mimari analiz</option>
          <option value="impact_analysis">Değişiklik etki ve risk analizi</option>
          <option value="security_explain">Güvenlik incelemesi</option>
          <option value="database_review">Veritabanı incelemesi</option>
          <option value="deployment_review">Yayına hazırlık incelemesi</option>
          <option value="project_plan">Teknik proje planı</option>
        </select>
      </Field>
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
