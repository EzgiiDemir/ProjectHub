'use client';

import { useInfiniteQuery, useMutation, useQuery } from '@tanstack/react-query';
import { Play } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { api, apiPaged, errorMessage } from '@/lib/api';
import { ago, duration, shortSha } from '@/lib/format';
import { useProject, useProjectSlug } from '@/lib/hooks';
import type { Branches, Build } from '@/lib/types';
import { Empty, ErrorState, Field, Loading, Modal, Panel, StatusBadge } from '@/components/ui';

const TRIGGER: Record<string, string> = { manual: 'Elle', push: 'Push', retry: 'Tekrar', ai: 'AI', upload: 'Yükleme', import: 'İçe aktarma' };

export default function BuildsPage() {
  const slug = useProjectSlug();
  const router = useRouter();
  const project = useProject().data;
  const [branch, setBranch] = useState('');
  const [open, setOpen] = useState(false);
  const branches = useQuery({ queryKey: ['repo', slug, 'branches'], queryFn: () => api<Branches>(`/projects/${slug}/repo/branches`) });
  const q = useInfiniteQuery({
    queryKey: ['builds', slug, branch],
    queryFn: ({ pageParam }) => apiPaged<Build>(`/projects/${slug}/builds?limit=30${branch ? `&branch=${encodeURIComponent(branch)}` : ''}${pageParam ? `&cursor=${pageParam}` : ''}`),
    initialPageParam: '',
    getNextPageParam: (last) => (last.meta.hasMore ? (last.meta.nextCursor ?? undefined) : undefined),
  });
  const rows = q.data?.pages.flatMap((p) => p.data) ?? [];
  const canBuild = !!project?.permissions.includes('build.create') && project.status !== 'archived';

  return (
    <>
      <div className="spread" style={{ marginBottom: 12 }}>
        <div>
          <h2 style={{ margin: 0 }}>Build&apos;ler</h2>
          <p className="sub">Her build izole bir klasörde kurulum, güvenlik kontrolü, derleme ve test adımlarından geçer.</p>
        </div>
        <div className="row">
          <select className="in" style={{ width: 'auto' }} value={branch} onChange={(e) => setBranch(e.target.value)} aria-label="Branch filtresi">
            <option value="">Tüm branch&apos;ler</option>
            {branches.data?.branches.map((b) => (
              <option key={b.name}>{b.name}</option>
            ))}
          </select>
          {canBuild && (
            <button className="btn pri" onClick={() => setOpen(true)} disabled={!branches.data?.branches.length}>
              <Play /> Build başlat
            </button>
          )}
        </div>
      </div>
      {q.isLoading && <Loading rows={6} />}
      {q.error && <ErrorState error={q.error} onRetry={() => void q.refetch()} />}
      {!q.isLoading && !q.error && (
        <Panel flush>
          {rows.length ? (
            <div className="tbl">
              <table>
                <thead>
                  <tr>
                    <th>#</th>
                    <th>Durum</th>
                    <th>Branch / commit</th>
                    <th>Tetikleyen</th>
                    <th>Süre</th>
                    <th>Zaman</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((b) => (
                    <tr key={b.id} className="click" onClick={() => router.push(`/projects/${slug}/builds/${b.id}`)}>
                      <td className="mono">#{b.number}</td>
                      <td>
                        <StatusBadge status={b.status} />
                      </td>
                      <td style={{ maxWidth: 380 }}>
                        <div className="ellipsis">
                          <span className="tag">{b.branch}</span> <span className="mono small">{shortSha(b.commitSha)}</span> {b.commitMessage}
                        </div>
                        {b.error && <div className="small ellipsis" style={{ color: 'var(--bad)' }}>{b.error.message}</div>}
                      </td>
                      <td className="small">
                        {TRIGGER[b.trigger] ?? b.trigger}
                        <div className="muted">{b.triggeredByName ?? '—'}</div>
                      </td>
                      <td className="mono small">{duration(b.durationMs)}</td>
                      <td className="small muted">{ago(b.createdAt)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <Empty title="Henüz build yok">Build başlattığınızda (veya AI görevi bir düzeltmeyi doğrularken) build&apos;ler burada listelenir.</Empty>
          )}
        </Panel>
      )}
      {q.hasNextPage && (
        <div style={{ textAlign: 'center', marginTop: 12 }}>
          <button className="btn" onClick={() => void q.fetchNextPage()} disabled={q.isFetchingNextPage}>
            Daha eski build&apos;ler
          </button>
        </div>
      )}
      {open && branches.data && <StartBuild slug={slug} branches={branches.data} canPreview={!!project?.permissions.includes('preview.create')} onClose={() => setOpen(false)} />}
    </>
  );
}

function StartBuild({ slug, branches, canPreview, onClose }: { slug: string; branches: Branches; canPreview: boolean; onClose: () => void }) {
  const router = useRouter();
  const [branch, setBranch] = useState(branches.defaultBranch);
  const [preview, setPreview] = useState(canPreview);
  const start = useMutation({
    mutationFn: () => api<Build>(`/projects/${slug}/builds`, { method: 'POST', body: { branch, createPreview: preview } }),
    onSuccess: (b) => router.push(`/projects/${slug}/builds/${b.id}`),
  });
  const head = branches.branches.find((b) => b.name === branch);
  return (
    <Modal
      title="Build başlat"
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            Vazgeç
          </button>
          <button className="btn pri" disabled={start.isPending} onClick={() => start.mutate()}>
            {start.isPending && <span className="spinner" />} Başlat
          </button>
        </>
      }
    >
      <Field label="Branch" id="b-branch">
        <select id="b-branch" className="in" value={branch} onChange={(e) => setBranch(e.target.value)}>
          {branches.branches.map((b) => (
            <option key={b.name} value={b.name}>
              {b.name}
              {b.isDefault ? ' (varsayılan)' : ''}
            </option>
          ))}
        </select>
      </Field>
      {head && (
        <p className="small muted" style={{ marginTop: -4 }}>
          Son commit <span className="mono">{shortSha(head.sha)}</span> · {head.subject} · {head.author}, {ago(head.date)}
        </p>
      )}
      {canPreview && (
        <label className="check">
          <input type="checkbox" checked={preview} onChange={(e) => setPreview(e.target.checked)} /> Başarılı olursa ön izleme oluştur
        </label>
      )}
      {start.error && <div className="badbox">{errorMessage(start.error)}</div>}
    </Modal>
  );
}
