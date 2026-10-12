'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, GitMerge, Play, X } from 'lucide-react';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useState } from 'react';
import { api, errorMessage } from '@/lib/api';
import { ago, dateTime, shortSha } from '@/lib/format';
import { useProjectSlug } from '@/lib/hooks';
import type { Build, PullRequestDetail } from '@/lib/types';
import { Async, DiffView, Markdown, Panel, StatusBadge, Tabs } from '@/components/ui';
import { useToast } from '@/components/toast';

const STATUS: Record<PullRequestDetail['status'], [string, string]> = { open: ['Açık', 'active'], merged: ['Birleştirildi', 'merged'], closed: ['Kapatıldı', 'cancelled'] };

export default function PullRequestPage() {
  const { number } = useParams<{ number: string }>();
  const slug = useProjectSlug();
  const router = useRouter();
  const toast = useToast();
  const qc = useQueryClient();
  const [tab, setTab] = useState<'conversation' | 'commits' | 'files'>('conversation');
  const [comment, setComment] = useState('');
  const [deleteBranch, setDeleteBranch] = useState(true);
  const key = ['pullRequest', slug, number];
  const q = useQuery({ queryKey: key, queryFn: () => api<PullRequestDetail>(`/projects/${slug}/pull-requests/${number}`) });
  const done = (msg?: string) => (d: PullRequestDetail) => {
    qc.setQueryData(key, d);
    void qc.invalidateQueries({ queryKey: ['pullRequests'] });
    if (msg) toast(msg);
  };
  const fail = (e: unknown) => toast(errorMessage(e), 'bad');
  const post = (path: string, body: unknown = {}) => api<PullRequestDetail>(`/projects/${slug}/pull-requests/${number}${path}`, { method: 'POST', body });
  const addComment = useMutation({ mutationFn: () => post('/comments', { body: comment }), onSuccess: (d) => (setComment(''), done()(d)), onError: fail });
  const review = useMutation({
    mutationFn: (decision: 'approved' | 'changes_requested') => post('/reviews', { decision, body: comment }),
    onSuccess: (d, decision) => (setComment(''), done(decision === 'approved' ? 'Onaylandı' : 'Değişiklik istendi')(d)),
    onError: fail,
  });
  const merge = useMutation({ mutationFn: () => post('/merge', { deleteSourceBranch: deleteBranch }), onSuccess: done('Birleştirildi'), onError: fail });
  const setOpen = useMutation({ mutationFn: (open: boolean) => post(open ? '/reopen' : '/close'), onSuccess: done(), onError: fail });
  const build = useMutation({
    mutationFn: (branch: string) => api<Build>(`/projects/${slug}/builds`, { method: 'POST', body: { branch, createPreview: false } }),
    onSuccess: (b) => router.push(`/projects/${slug}/builds/${b.id}`),
    onError: fail,
  });

  return (
    <Async q={q} rows={6}>
      {(pr) => (
        <>
          <div style={{ marginBottom: 12 }}>
            <div className="small muted">
              <Link href={`/projects/${slug}/pull-requests`}>Pull request&apos;ler</Link> /
            </div>
            <h2 style={{ margin: '2px 0 4px' }}>
              {pr.title} <span className="muted">#{pr.number}</span>
            </h2>
            <div className="row small">
              <StatusBadge status={STATUS[pr.status][1]} label={STATUS[pr.status][0]} />
              <span>
                <b>{pr.authorName}</b>, <span className="tag">{pr.sourceBranch}</span> → <span className="tag">{pr.targetBranch}</span> · {ago(pr.createdAt)}
              </span>
              {pr.mergedAt && (
                <span className="muted">
                  · {pr.mergedByName} birleştirdi, {dateTime(pr.mergedAt)} (<span className="mono">{shortSha(pr.mergeCommit)}</span>)
                </span>
              )}
            </div>
          </div>
          <div className="grid" style={{ gridTemplateColumns: 'minmax(0, 1fr) 320px', alignItems: 'start' }}>
            <div>
              <Tabs
                value={tab}
                onChange={setTab}
                items={[
                  ['conversation', 'Konuşma'],
                  ['commits', `Commit'ler (${pr.diff?.commits.length ?? 0})`],
                  ['files', `Dosyalar (${pr.diff?.files.length ?? 0})`],
                ]}
              />
              {tab === 'conversation' && (
                <>
                  <Panel>{pr.description ? <Markdown text={pr.description} /> : <p className="muted small" style={{ margin: 0 }}>Açıklama yok.</p>}</Panel>
                  <div className="mt">
                    {[...pr.reviews.map((r) => ({ kind: 'review' as const, at: r.createdAt, r })), ...pr.comments.map((c) => ({ kind: 'comment' as const, at: c.createdAt, c }))]
                      .sort((a, b) => a.at.localeCompare(b.at))
                      .map((item) =>
                        item.kind === 'review' ? (
                          <div key={item.r.id} className="panel" style={{ padding: 12, marginBottom: 8, borderLeft: `3px solid ${item.r.decision === 'approved' ? 'var(--ok)' : 'var(--warn)'}` }}>
                            <div className="small">
                              <b>{item.r.userName}</b> {item.r.decision === 'approved' ? 'onayladı' : 'değişiklik istedi'} · <span className="mono">{shortSha(item.r.commitSha)}</span> · {ago(item.r.createdAt)}
                              {item.r.stale && <span className="muted"> · eski commit</span>}
                            </div>
                            {item.r.body && <div style={{ whiteSpace: 'pre-wrap', marginTop: 4 }}>{item.r.body}</div>}
                          </div>
                        ) : (
                          <div key={item.c.id} className="panel" style={{ padding: 12, marginBottom: 8 }}>
                            <div className="small">
                              <b>{item.c.author}</b> · {ago(item.c.createdAt)}
                              {item.c.path && (
                                <span className="mono muted">
                                  {' '}
                                  · {item.c.path}
                                  {item.c.line ? `:${item.c.line}` : ''}
                                </span>
                              )}
                            </div>
                            <div style={{ whiteSpace: 'pre-wrap', marginTop: 4 }}>{item.c.body}</div>
                          </div>
                        ),
                      )}
                  </div>
                  <div className="panel" style={{ padding: 12 }}>
                    <textarea className="in" placeholder="Yorum veya inceleme notu" value={comment} onChange={(e) => setComment(e.target.value)} maxLength={5000} />
                    <div className="row" style={{ marginTop: 8, justifyContent: 'flex-end' }}>
                      <button className="btn" disabled={!comment.trim() || addComment.isPending} onClick={() => addComment.mutate()}>
                        Yorum yap
                      </button>
                      {pr.status === 'open' && pr.permissions.canReview && (
                        <>
                          <button className="btn" disabled={review.isPending} onClick={() => review.mutate('changes_requested')}>
                            <X /> Değişiklik iste
                          </button>
                          <button className="btn pri" disabled={review.isPending} onClick={() => review.mutate('approved')}>
                            <Check /> Onayla
                          </button>
                        </>
                      )}
                    </div>
                  </div>
                </>
              )}
              {tab === 'commits' && (
                <Panel flush>
                  {pr.diff?.commits.length ? (
                    pr.diff.commits.map((c) => (
                      <Link key={c.sha} className="list-item" href={`/projects/${slug}/git?tab=commits&commit=${c.sha}`}>
                        <span className="mono small muted">{shortSha(c.sha)}</span>
                        <span className="ellipsis" style={{ flex: 1 }}>
                          {c.subject}
                        </span>
                        <span className="small muted">
                          {c.authorName} · {ago(c.date)}
                        </span>
                      </Link>
                    ))
                  ) : (
                    <p className="small muted" style={{ padding: 16, margin: 0 }}>Commit yok.</p>
                  )}
                </Panel>
              )}
              {tab === 'files' && (pr.diff ? <DiffView patch={pr.diff.patch} maxHeight={900} /> : <p className="small muted">Fark gösterilemiyor.</p>)}
            </div>
            <div className="grid" style={{ gap: 14 }}>
              <Panel title="Kontroller">
                <div className="small" style={{ display: 'grid', gap: 6 }}>
                  <div>
                    {pr.checks.protected ? '🔒' : '·'} Hedef branch {pr.checks.protected ? 'korumalı' : 'korumasız'}
                  </div>
                  <div style={{ color: pr.checks.approvals >= pr.checks.requiredApprovals ? 'var(--ok)' : 'var(--warn)' }}>
                    {pr.checks.approvals >= pr.checks.requiredApprovals ? '✓' : '○'} Onay: {pr.checks.approvals}/{pr.checks.requiredApprovals}
                  </div>
                  {pr.checks.changesRequested && <div style={{ color: 'var(--warn)' }}>○ Değişiklik istendi</div>}
                  <div style={{ color: pr.build?.status === 'passed' ? 'var(--ok)' : pr.checks.requiresBuild ? 'var(--warn)' : 'var(--muted)' }}>
                    {pr.build?.status === 'passed' ? '✓' : '○'} Build:{' '}
                    {pr.build ? (
                      <Link href={`/projects/${slug}/builds/${pr.build.id}`}>
                        #{pr.build.number} <StatusBadge status={pr.build.status} />
                      </Link>
                    ) : (
                      'son commit için yok'
                    )}
                    {pr.checks.requiresBuild && ' (zorunlu)'}
                  </div>
                  {pr.mergeCheck && (
                    <div style={{ color: pr.mergeCheck.conflicts.length ? 'var(--bad)' : 'var(--ok)' }}>
                      {pr.mergeCheck.conflicts.length ? `✗ Çakışma: ${pr.mergeCheck.conflicts.join(', ')}` : `✓ Çakışma yok${pr.mergeCheck.fastForward ? ' (ileri sarma)' : ''}`}
                    </div>
                  )}
                </div>
                {pr.status === 'open' && pr.headCommit && pr.build?.status !== 'passed' && pr.build?.status !== 'running' && pr.build?.status !== 'queued' && (
                  <button className="btn sm" style={{ marginTop: 10 }} onClick={() => build.mutate(pr.sourceBranch)} disabled={build.isPending}>
                    <Play size={14} /> Son commit&apos;i build et
                  </button>
                )}
              </Panel>
              {pr.status === 'open' && pr.permissions.canMerge && (
                <Panel title="Birleştir">
                  {pr.checks.blockers.length > 0 && (
                    <div className="warnbox small" style={{ marginBottom: 10 }}>
                      {pr.checks.blockers.map((b) => (
                        <div key={b}>• {b}</div>
                      ))}
                    </div>
                  )}
                  <label className="check small">
                    <input type="checkbox" checked={deleteBranch} onChange={(e) => setDeleteBranch(e.target.checked)} /> Birleştirince <span className="tag">{pr.sourceBranch}</span> branch&apos;ini sil
                  </label>
                  <button className="btn pri" style={{ width: '100%', justifyContent: 'center', marginTop: 8 }} disabled={!pr.checks.mergeable || merge.isPending} onClick={() => merge.mutate()}>
                    <GitMerge /> {pr.targetBranch} branch&apos;ine birleştir
                  </button>
                </Panel>
              )}
              {pr.permissions.canEdit && pr.status !== 'merged' && (
                <button className="btn" onClick={() => setOpen.mutate(pr.status !== 'open')} disabled={setOpen.isPending}>
                  {pr.status === 'open' ? 'Pull request\'i kapat' : 'Yeniden aç'}
                </button>
              )}
            </div>
          </div>
        </>
      )}
    </Async>
  );
}
