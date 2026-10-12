'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, OctagonX, X } from 'lucide-react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useState } from 'react';
import { api, errorMessage } from '@/lib/api';
import { dateTime, shortSha } from '@/lib/format';
import { useProjectSlug } from '@/lib/hooks';
import type { AiTask } from '@/lib/types';
import { Async, DiffView, KeyValue, Loading, Modal, Panel, StatusBadge } from '@/components/ui';
import { useToast } from '@/components/toast';

const SOURCE_LINK: Record<string, (slug: string, id: string) => string> = {
  feedback: (s, id) => `/projects/${s}/feedback/${id}`,
  build: (s, id) => `/projects/${s}/builds/${id}`,
  finding: (s, id) => `/projects/${s}/security?finding=${id}`,
};

/** Spec §74–79: the AI's proposal as a reviewable change. Merging is always a human decision. */
export default function AiTaskPage() {
  const { taskId } = useParams<{ taskId: string }>();
  const slug = useProjectSlug();
  const qc = useQueryClient();
  const toast = useToast();
  const [decision, setDecision] = useState<'approve' | 'reject' | null>(null);
  const [comment, setComment] = useState('');
  const q = useQuery({
    queryKey: ['aiTask', taskId],
    queryFn: () => api<AiTask>(`/ai/tasks/${taskId}`),
    refetchInterval: (query) => (query.state.data && ['queued', 'running'].includes(query.state.data.status) ? 2500 : query.state.data?.build && ['queued', 'running'].includes(query.state.data.build.status) ? 4000 : false),
  });
  const decide = useMutation({
    mutationFn: (kind: 'approve' | 'reject') => api<AiTask>(`/ai/tasks/${taskId}/${kind}`, { method: 'POST', body: { comment: comment || undefined } }),
    onSuccess: (t, kind) => {
      qc.setQueryData(['aiTask', taskId], t);
      void qc.invalidateQueries({ queryKey: ['aiTasks'] });
      toast(kind === 'approve' ? `Değişiklik ${t.baseBranch} branch'ine birleştirildi` : 'Öneri reddedildi');
      setDecision(null);
    },
    onError: (e) => toast(errorMessage(e), 'bad'),
  });
  const cancel = useMutation({
    mutationFn: () => api<AiTask>(`/ai/tasks/${taskId}/cancel`, { method: 'POST' }),
    onSuccess: (t) => {
      qc.setQueryData(['aiTask', taskId], t);
      void qc.invalidateQueries({ queryKey: ['aiTasks'] });
      toast('AI görevi iptal edildi');
    },
    onError: (e) => toast(errorMessage(e), 'bad'),
  });

  return (
    <Async q={q} rows={6}>
      {(t) => {
        const working = t.status === 'queued' || t.status === 'running';
        return (
          <>
            <div className="spread" style={{ marginBottom: 12 }}>
              <div>
                <div className="small muted">
                  <Link href={`/projects/${slug}/ai?tab=tasks`}>AI görevleri</Link> / {t.key}
                </div>
                <h2 style={{ margin: '2px 0 4px' }} className="row">
                  {t.title} <StatusBadge status={t.status} />
                </h2>
                <p className="sub" style={{ margin: 0 }}>
                  {t.requestedByName ?? '—'} · {dateTime(t.createdAt)} · seviye {t.autonomyLevel}
                </p>
              </div>
              {working && (
                <button className="btn danger" onClick={() => cancel.mutate()} disabled={cancel.isPending}>
                  {cancel.isPending ? <span className="spinner" /> : <OctagonX />} Görevi iptal et
                </button>
              )}
              {t.status === 'awaiting_approval' && t.canApprove && (
                <div className="row">
                  <button className="btn" onClick={() => setDecision('reject')}>
                    <X /> Reddet
                  </button>
                  <button className="btn pri" onClick={() => setDecision('approve')} disabled={t.build?.status === 'failed' || t.build?.status === 'running' || t.build?.status === 'queued'} title={t.build && t.build.status !== 'passed' ? 'Doğrulama build’i başarılı olmadan birleştirilemez' : undefined}>
                    <Check /> Onayla ve birleştir
                  </button>
                </div>
              )}
            </div>
            {working && (
              <div className="ai-note" style={{ marginBottom: 14 }}>
                <Loading label="AI kodu inceliyor ve değişikliği hazırlıyor… Bu sayfa kendiliğinden güncellenir." />
              </div>
            )}
            {t.error && <div className="badbox" style={{ marginBottom: 14 }}>{t.error}</div>}
            {t.decisionComment && (
              <div className="panel" style={{ padding: 12, marginBottom: 14 }}>
                <b>Karar notu:</b> {t.decisionComment}
              </div>
            )}
            <div className="grid" style={{ gridTemplateColumns: 'minmax(0, 1fr) 320px', alignItems: 'start' }}>
              <div className="grid" style={{ gap: 14 }}>
                {t.result && (
                  <Panel title="AI açıklaması">
                    <div className="ai-note">
                      <b>{t.result.summary}</b>
                      <ul style={{ margin: '6px 0 0', paddingLeft: 18 }}>
                        {t.result.explanation.map((e, i) => (
                          <li key={i}>{e}</li>
                        ))}
                      </ul>
                    </div>
                  </Panel>
                )}
                {t.diff ? (
                  <Panel title={`Değişiklik (${t.result?.filesChanged.length ?? 0} dosya)`}>
                    <DiffView patch={t.diff.patch} maxHeight={720} />
                    {t.diff.truncated && <p className="small muted">Fark çok büyük; ilk kısmı gösteriliyor.</p>}
                  </Panel>
                ) : (
                  !working && <Panel title="Değişiklik"><p className="small muted" style={{ margin: 0 }}>Kod değişikliği yok.</p></Panel>
                )}
                <Panel title="Talimat">
                  <pre style={{ whiteSpace: 'pre-wrap', margin: 0, font: 'inherit', fontSize: 13 }}>{t.instruction}</pre>
                </Panel>
              </div>
              <div className="grid" style={{ gap: 14 }}>
                <Panel title="Ayrıntılar">
                  <KeyValue
                    items={[
                      ['Kaynak', t.sourceType && t.sourceId && SOURCE_LINK[t.sourceType] ? <Link key="s" href={SOURCE_LINK[t.sourceType]!(slug, t.sourceId)}>{t.sourceType === 'feedback' ? 'Geri bildirim' : t.sourceType === 'build' ? 'Build' : 'Güvenlik bulgusu'}</Link> : 'Elle'],
                      ['Temel', t.baseBranch ? <span key="b" className="tag">{t.baseBranch}</span> : '—'],
                      ['AI branch', t.branch ? <Link key="br" className="mono small" href={`/projects/${slug}/code?ref=${encodeURIComponent(t.branch)}`}>{t.branch}</Link> : '—'],
                      ['Commit', <span key="c" className="mono">{shortSha(t.headCommit)}</span>],
                      [
                        'Doğrulama build',
                        t.build ? (
                          <Link key="bd" href={`/projects/${slug}/builds/${t.build.id}`}>
                            #{t.build.number} <StatusBadge status={t.build.status} />
                          </Link>
                        ) : (
                          '—'
                        ),
                      ],
                      ['Tamamlandı', dateTime(t.completedAt)],
                    ]}
                  />
                  {t.build?.status === 'failed' && t.status === 'awaiting_approval' && <div className="warnbox small" style={{ marginTop: 10 }}>Doğrulama build&apos;i başarısız; bu değişiklik birleştirilemez. Reddedip yeni talimatla tekrar deneyin.</div>}
                </Panel>
                {!!t.result?.filesChanged.length && (
                  <Panel title="Dosyalar">
                    {t.result.filesChanged.map((f) => (
                      <div key={f.path} className="mono small">
                        <span style={{ color: 'var(--ok)' }}>+{f.additions}</span> <span style={{ color: 'var(--bad)' }}>−{f.deletions}</span> {f.path}
                      </div>
                    ))}
                  </Panel>
                )}
                {!!t.actions?.length && (
                  <Panel title="AI işlem kaydı" flush>
                    {t.actions.map((a) => (
                      <div key={a.id} className="list-item small">
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <span className="mono">{a.action}</span> {a.resource && <span className="muted ellipsis">{a.resource}</span>}
                        </div>
                        <StatusBadge status={a.decision === 'allowed' ? 'passed' : 'failed'} label={a.decision === 'allowed' ? 'izinli' : 'engellendi'} />
                      </div>
                    ))}
                  </Panel>
                )}
              </div>
            </div>
            {decision && (
              <Modal
                title={decision === 'approve' ? 'Onayla ve birleştir' : 'Öneriyi reddet'}
                onClose={() => setDecision(null)}
                footer={
                  <>
                    <button className="btn" onClick={() => setDecision(null)}>
                      Vazgeç
                    </button>
                    <button className={`btn ${decision === 'approve' ? 'pri' : 'danger solid'}`} disabled={decide.isPending} onClick={() => decide.mutate(decision)}>
                      {decide.isPending && <span className="spinner" />} {decision === 'approve' ? 'Birleştir' : 'Reddet'}
                    </button>
                  </>
                }
              >
                <p style={{ marginTop: 0 }}>
                  {decision === 'approve' ? (
                    <>
                      <span className="tag">{t.branch}</span> branch&apos;i <span className="tag">{t.baseBranch}</span> branch&apos;ine birleştirilecek. Bu bir deployment değildir; yayına almak için versiyon oluşturup deploy edin.
                    </>
                  ) : (
                    'AI branch’i silinir; görev, açıklama ve işlem kaydı denetim için saklanır.'
                  )}
                </p>
                <textarea className="in" placeholder="Not (isteğe bağlı)" value={comment} onChange={(e) => setComment(e.target.value)} maxLength={2000} />
              </Modal>
            )}
          </>
        );
      }}
    </Async>
  );
}
