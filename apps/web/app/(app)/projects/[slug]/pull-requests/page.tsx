'use client';

import { useMutation, useQuery } from '@tanstack/react-query';
import { GitPullRequestArrow } from 'lucide-react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useState } from 'react';
import { api, errorMessage } from '@/lib/api';
import { ago } from '@/lib/format';
import { useProject, useProjectSlug } from '@/lib/hooks';
import type { Branches, PullRequest } from '@/lib/types';
import { Async, Empty, Field, Modal, Panel, StatusBadge } from '@/components/ui';

const STATUS: Record<PullRequest['status'], [string, string]> = { open: ['Açık', 'active'], merged: ['Birleştirildi', 'merged'], closed: ['Kapatıldı', 'cancelled'] };

/** Pull requests (spec §33, §104): reviewed, verified changes into a target branch. */
export default function PullRequestsPage() {
  const slug = useProjectSlug();
  const router = useRouter();
  const params = useSearchParams();
  const project = useProject().data;
  const [status, setStatus] = useState<'open' | 'merged' | 'closed' | ''>('open');
  const q = useQuery({ queryKey: ['pullRequests', slug, status], queryFn: () => api<PullRequest[]>(`/projects/${slug}/pull-requests${status ? `?status=${status}` : ''}`) });
  const canOpen = !!project?.permissions.includes('repository.push') && project.status !== 'archived';
  const creating = params.get('new') === '1';
  const protectedBranches = ((project?.settings as { protection?: { branches?: string[] } } | undefined)?.protection?.branches ?? []).join(', ');

  return (
    <>
      <div className="spread" style={{ marginBottom: 12 }}>
        <div>
          <h2 style={{ margin: 0 }}>Pull request&apos;ler</h2>
          <p className="sub">
            Bir branch&apos;teki değişiklik incelenir, build ile doğrulanır ve hedef branch&apos;e birleştirilir.
            {protectedBranches ? ` Korumalı branch'ler: ${protectedBranches} — yalnızca pull request ile değişir.` : ''}
          </p>
        </div>
        {canOpen && (
          <button className="btn pri" onClick={() => router.replace(`/projects/${slug}/pull-requests?new=1`)}>
            <GitPullRequestArrow /> Pull request aç
          </button>
        )}
      </div>
      <div className="row" style={{ marginBottom: 10 }}>
        {(
          [
            ['open', 'Açık'],
            ['merged', 'Birleştirilen'],
            ['closed', 'Kapatılan'],
            ['', 'Tümü'],
          ] as const
        ).map(([k, l]) => (
          <button key={k} className={`chip ${status === k ? 'on' : ''}`} onClick={() => setStatus(k)}>
            {l}
          </button>
        ))}
      </div>
      <Async q={q} rows={4}>
        {(rows) =>
          rows.length ? (
            <Panel flush>
              {rows.map((pr) => (
                <button key={pr.id} className="list-item" style={{ width: '100%', background: 'none', border: 0, borderBottom: '1px solid var(--line)', cursor: 'pointer', textAlign: 'left', font: 'inherit' }} onClick={() => router.push(`/projects/${slug}/pull-requests/${pr.number}`)}>
                  <StatusBadge status={STATUS[pr.status][1]} label={STATUS[pr.status][0]} />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div className="ellipsis">
                      <b>{pr.title}</b> <span className="mono small muted">#{pr.number}</span>
                    </div>
                    <div className="small muted">
                      <span className="tag">{pr.sourceBranch}</span> → <span className="tag">{pr.targetBranch}</span> · {pr.authorName} · {ago(pr.createdAt)}
                      {pr.mergedByName && ` · birleştiren ${pr.mergedByName}`}
                    </div>
                  </div>
                </button>
              ))}
            </Panel>
          ) : (
            <Empty title="Pull request yok">Bir branch&apos;teki değişikliği hedef branch&apos;e almak için pull request açın.</Empty>
          )
        }
      </Async>
      {creating && canOpen && <OpenPullRequest slug={slug} initialSource={params.get('source')} initialTarget={params.get('target')} onClose={() => router.replace(`/projects/${slug}/pull-requests`)} />}
    </>
  );
}

function OpenPullRequest({ slug, initialSource, initialTarget, onClose }: { slug: string; initialSource: string | null; initialTarget: string | null; onClose: () => void }) {
  const router = useRouter();
  const branches = useQuery({ queryKey: ['repo', slug, 'branches'], queryFn: () => api<Branches>(`/projects/${slug}/repo/branches`) });
  const candidates = (branches.data?.branches ?? []).filter((b) => !b.name.startsWith('ai/'));
  const [source, setSource] = useState(initialSource ?? '');
  const [target, setTarget] = useState(initialTarget ?? '');
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const src = source || candidates.find((b) => !b.isDefault && b.ahead > 0)?.name || '';
  const tgt = target || branches.data?.defaultBranch || '';
  const open = useMutation({
    mutationFn: () => api<PullRequest>(`/projects/${slug}/pull-requests`, { method: 'POST', body: { title, description, sourceBranch: src, targetBranch: tgt } }),
    onSuccess: (pr) => router.push(`/projects/${slug}/pull-requests/${pr.number}`),
  });
  return (
    <Modal
      title="Pull request aç"
      onClose={onClose}
      wide
      footer={
        <>
          <button className="btn" onClick={onClose}>
            Vazgeç
          </button>
          <button className="btn pri" disabled={!title.trim() || !src || !tgt || src === tgt || open.isPending} onClick={() => open.mutate()}>
            Aç
          </button>
        </>
      }
    >
      <div className="grid g2">
        <Field label="Kaynak (değişikliğin olduğu branch)" id="pr-src">
          <select id="pr-src" className="in" value={src} onChange={(e) => setSource(e.target.value)}>
            <option value="">Seçin</option>
            {candidates.map((b) => (
              <option key={b.name} value={b.name}>
                {b.name} {b.isDefault ? '' : `(↑${b.ahead})`}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Hedef" id="pr-tgt">
          <select id="pr-tgt" className="in" value={tgt} onChange={(e) => setTarget(e.target.value)}>
            {candidates.map((b) => (
              <option key={b.name} value={b.name}>
                {b.name}
              </option>
            ))}
          </select>
        </Field>
      </div>
      <Field label="Başlık" id="pr-title">
        <input id="pr-title" className="in" value={title} onChange={(e) => setTitle(e.target.value)} maxLength={200} placeholder="ör. Ödeme sayfasında kargo hesabı düzeltildi" />
      </Field>
      <Field label="Açıklama" id="pr-desc" hint="Ne değişti, nasıl test edilir? Markdown desteklenir.">
        <textarea id="pr-desc" className="in" style={{ minHeight: 140 }} value={description} onChange={(e) => setDescription(e.target.value)} maxLength={20000} />
      </Field>
      {open.error && <div className="badbox">{errorMessage(open.error)}</div>}
    </Modal>
  );
}
