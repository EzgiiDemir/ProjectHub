'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { GitBranchPlus, GitMerge, Trash2 } from 'lucide-react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useState } from 'react';
import { api, errorMessage } from '@/lib/api';
import { ago, dateTime, shortSha } from '@/lib/format';
import { useProject, useProjectSlug } from '@/lib/hooks';
import type { Branches, Commit, CommitDetail, Comparison } from '@/lib/types';
import { Async, ConfirmDialog, CopyButton, DiffView, Drawer, Empty, Field, Modal, Panel, Tabs } from '@/components/ui';
import { useToast } from '@/components/toast';

type Tab = 'branches' | 'commits' | 'compare';

/** Branches, history and compare/merge over the hub-managed repository (spec §36–38). */
export default function GitPage() {
  const slug = useProjectSlug();
  const params = useSearchParams();
  const router = useRouter();
  const project = useProject().data;
  const tab = (params.get('tab') as Tab) ?? 'branches';
  const set = (next: Record<string, string>) => {
    const sp = new URLSearchParams(params);
    for (const [k, v] of Object.entries(next)) v ? sp.set(k, v) : sp.delete(k);
    router.replace(`/projects/${slug}/git?${sp}`);
  };
  const branches = useQuery({ queryKey: ['repo', slug, 'branches'], queryFn: () => api<Branches>(`/projects/${slug}/repo/branches`) });
  const canPush = !!project?.permissions.includes('repository.push') && project.status !== 'archived';
  const commitSha = params.get('commit');

  return (
    <>
      <div className="spread" style={{ marginBottom: 6 }}>
        <div>
          <h2 style={{ margin: 0 }}>Branch ve commit</h2>
          <p className="sub">
            Repository Project Hub üzerinde barınır. Klonlamak için: <code className="small">git clone {project?.repository?.cloneUrl}</code>{' '}
            {project?.repository && <CopyButton text={`git clone ${project.repository.cloneUrl}`} />}
          </p>
        </div>
      </div>
      <Tabs
        value={tab}
        onChange={(t) => set({ tab: t })}
        items={[
          ['branches', `Branch'ler${branches.data ? ` (${branches.data.branches.length})` : ''}`],
          ['commits', 'Commit geçmişi'],
          ['compare', 'Karşılaştır ve birleştir'],
        ]}
      />
      <Async q={branches} rows={4}>
        {(b) => (
          <>
            {tab === 'branches' && <BranchList slug={slug} data={b} canPush={canPush} onCompare={(head) => set({ tab: 'compare', base: b.defaultBranch, head })} onHistory={(ref) => set({ tab: 'commits', ref })} />}
            {tab === 'commits' && <CommitLog slug={slug} data={b} refName={params.get('ref') ?? params.get('branch') ?? b.defaultBranch} onRef={(ref) => set({ ref })} onOpen={(sha) => set({ commit: sha })} />}
            {tab === 'compare' && <Compare slug={slug} data={b} base={params.get('base') ?? b.defaultBranch} head={params.get('head') ?? b.branches.find((x) => !x.isDefault)?.name ?? b.defaultBranch} canPush={canPush} onChange={(base, head) => set({ base, head })} onOpen={(sha) => set({ commit: sha })} />}
          </>
        )}
      </Async>
      {commitSha && <CommitDrawer slug={slug} sha={commitSha} onClose={() => set({ commit: '' })} />}
    </>
  );
}

function BranchList({ slug, data, canPush, onCompare, onHistory }: { slug: string; data: Branches; canPush: boolean; onCompare: (head: string) => void; onHistory: (ref: string) => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [creating, setCreating] = useState(false);
  const [deleting, setDeleting] = useState<string | null>(null);
  const del = useMutation({
    mutationFn: (name: string) => api(`/projects/${slug}/repo/branches?name=${encodeURIComponent(name)}`, { method: 'DELETE' }),
    onSuccess: () => {
      toast('Branch silindi');
      setDeleting(null);
      void qc.invalidateQueries({ queryKey: ['repo', slug] });
    },
    onError: (e) => toast(errorMessage(e), 'bad'),
  });
  return (
    <>
      {canPush && (
        <div style={{ textAlign: 'right', marginBottom: 10 }}>
          <button className="btn pri" onClick={() => setCreating(true)}>
            <GitBranchPlus /> Branch oluştur
          </button>
        </div>
      )}
      <Panel flush>
        <div className="tbl">
          <table>
            <thead>
              <tr>
                <th>Branch</th>
                <th>Son commit</th>
                <th title={`${data.defaultBranch} branch'ine göre`}>Önde / geride</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {data.branches.map((b) => (
                <tr key={b.name}>
                  <td>
                    <span className="tag">{b.name}</span> {b.isDefault && <span className="small muted">varsayılan</span>}
                    {b.name.startsWith('ai/') && <span className="small muted"> · AI görevi</span>}
                  </td>
                  <td style={{ maxWidth: 380 }}>
                    <div className="ellipsis small">
                      <span className="mono">{shortSha(b.sha)}</span> {b.subject}
                    </div>
                    <div className="small muted">
                      {b.author} · {ago(b.date)}
                    </div>
                  </td>
                  <td className="mono small">{b.isDefault ? '—' : `↑${b.ahead} ↓${b.behind}`}</td>
                  <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                    <button className="btn sm ghost" onClick={() => onHistory(b.name)}>
                      Geçmiş
                    </button>
                    <Link className="btn sm ghost" href={`/projects/${slug}/code?ref=${encodeURIComponent(b.name)}`}>
                      Kod
                    </Link>
                    {!b.isDefault && (
                      <button className="btn sm ghost" onClick={() => onCompare(b.name)}>
                        Karşılaştır
                      </button>
                    )}
                    {canPush && !b.isDefault && (
                      <button className="btn sm ghost" title="Sil" onClick={() => setDeleting(b.name)}>
                        <Trash2 size={14} />
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Panel>
      {data.tags.length > 0 && (
        <Panel title="Etiketler (sürümler)" className="mt">
          <div className="row">
            {data.tags.map((t) => (
              <span key={t.name} className="tag" title={t.sha}>
                {t.name}
              </span>
            ))}
          </div>
        </Panel>
      )}
      {creating && <CreateBranch slug={slug} data={data} onClose={() => setCreating(false)} />}
      {deleting && (
        <ConfirmDialog
          title="Branch'i sil"
          message={
            <>
              <span className="tag">{deleting}</span> silinecek. Başka bir branch&apos;e birleştirilmemiş commit&apos;ler kaybolabilir.
            </>
          }
          confirmText={deleting}
          actionLabel="Sil"
          busy={del.isPending}
          onConfirm={() => del.mutate(deleting)}
          onClose={() => setDeleting(null)}
        />
      )}
    </>
  );
}

function CreateBranch({ slug, data, onClose }: { slug: string; data: Branches; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [name, setName] = useState('feature/');
  const [from, setFrom] = useState(data.defaultBranch);
  const create = useMutation({
    mutationFn: () => api(`/projects/${slug}/repo/branches`, { method: 'POST', body: { name: name.trim(), from } }),
    onSuccess: () => {
      toast('Branch oluşturuldu');
      void qc.invalidateQueries({ queryKey: ['repo', slug] });
      onClose();
    },
  });
  return (
    <Modal
      title="Branch oluştur"
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            Vazgeç
          </button>
          <button className="btn pri" disabled={!name.trim() || name.endsWith('/') || create.isPending} onClick={() => create.mutate()}>
            Oluştur
          </button>
        </>
      }
    >
      <Field label="Ad" id="br-name" hint="ör. feature/odeme-sayfasi, fix/menu-tasmasi">
        <input id="br-name" className="in mono" value={name} onChange={(e) => setName(e.target.value)} autoFocus />
      </Field>
      <Field label="Kaynak" id="br-from">
        <select id="br-from" className="in" value={from} onChange={(e) => setFrom(e.target.value)}>
          {data.branches.map((b) => (
            <option key={b.name}>{b.name}</option>
          ))}
        </select>
      </Field>
      {create.error && <div className="badbox">{errorMessage(create.error)}</div>}
    </Modal>
  );
}

function CommitLog({ slug, data, refName, onRef, onOpen }: { slug: string; data: Branches; refName: string; onRef: (r: string) => void; onOpen: (sha: string) => void }) {
  const [search, setSearch] = useState('');
  const [submitted, setSubmitted] = useState('');
  const [limit, setLimit] = useState(40);
  const q = useQuery({
    queryKey: ['repo', slug, 'commits', refName, submitted, limit],
    queryFn: () => api<Commit[]>(`/projects/${slug}/repo/commits?ref=${encodeURIComponent(refName)}&limit=${limit}${submitted ? `&search=${encodeURIComponent(submitted)}` : ''}`),
  });
  return (
    <>
      <div className="row" style={{ marginBottom: 10 }}>
        <select className="in" style={{ width: 'auto' }} value={refName} onChange={(e) => onRef(e.target.value)} aria-label="Branch">
          {data.branches.map((b) => (
            <option key={b.name}>{b.name}</option>
          ))}
        </select>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            setSubmitted(search.trim());
          }}
          style={{ flex: 1, maxWidth: 360 }}
        >
          <input className="in" placeholder="Commit mesajında ara" value={search} onChange={(e) => setSearch(e.target.value)} />
        </form>
      </div>
      <Async q={q} rows={6}>
        {(rows) =>
          rows.length ? (
            <Panel flush>
              {rows.map((c) => (
                <button key={c.sha} className="list-item" style={{ width: '100%', background: 'none', border: 0, borderBottom: '1px solid var(--line)', cursor: 'pointer', textAlign: 'left', font: 'inherit' }} onClick={() => onOpen(c.sha)}>
                  <span className="mono small muted" style={{ minWidth: 60 }}>
                    {shortSha(c.sha)}
                  </span>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div className="ellipsis">{c.subject}</div>
                    <div className="small muted">
                      {c.authorName} · {ago(c.date)}
                      {c.parents.length > 1 && ' · birleştirme'}
                    </div>
                  </div>
                  <span className="mono small">
                    <span style={{ color: 'var(--ok)' }}>+{c.additions}</span> <span style={{ color: 'var(--bad)' }}>−{c.deletions}</span>
                  </span>
                </button>
              ))}
              {rows.length >= limit && (
                <div style={{ padding: 10, textAlign: 'center' }}>
                  <button className="btn sm" onClick={() => setLimit((l) => Math.min(100, l + 30))} disabled={limit >= 100}>
                    {limit >= 100 ? 'Daha eskisi için Git istemcisini kullanın' : 'Daha fazla'}
                  </button>
                </div>
              )}
            </Panel>
          ) : (
            <Empty title="Commit bulunamadı" />
          )
        }
      </Async>
    </>
  );
}

function Compare({ slug, data, base, head, canPush, onChange, onOpen }: { slug: string; data: Branches; base: string; head: string; canPush: boolean; onChange: (base: string, head: string) => void; onOpen: (sha: string) => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [merging, setMerging] = useState(false);
  const q = useQuery({ queryKey: ['repo', slug, 'compare', base, head], queryFn: () => api<Comparison>(`/projects/${slug}/repo/compare?base=${encodeURIComponent(base)}&head=${encodeURIComponent(head)}`), enabled: base !== head });
  const merge = useMutation({
    mutationFn: () => api<{ sha: string; fastForward: boolean }>(`/projects/${slug}/repo/merge`, { method: 'POST', body: { source: head, target: base } }),
    onSuccess: (r) => {
      toast(r.fastForward ? `${base} ileri sarıldı (${shortSha(r.sha)})` : `Birleştirme commit'i ${shortSha(r.sha)} oluşturuldu`);
      setMerging(false);
      void qc.invalidateQueries({ queryKey: ['repo', slug] });
    },
    onError: (e) => {
      setMerging(false);
      toast(errorMessage(e), 'bad');
    },
  });
  const isAi = head.startsWith('ai/');
  return (
    <>
      <div className="row" style={{ marginBottom: 12 }}>
        <select className="in" style={{ width: 'auto' }} value={base} onChange={(e) => onChange(e.target.value, head)} aria-label="Hedef">
          {data.branches.map((b) => (
            <option key={b.name}>{b.name}</option>
          ))}
        </select>
        <span className="muted">←</span>
        <select className="in" style={{ width: 'auto' }} value={head} onChange={(e) => onChange(base, e.target.value)} aria-label="Kaynak">
          {data.branches.map((b) => (
            <option key={b.name}>{b.name}</option>
          ))}
        </select>
        <div style={{ flex: 1 }} />
        {canPush && q.data && q.data.ahead > 0 && !isAi && (
          <button className="btn pri" onClick={() => setMerging(true)}>
            <GitMerge /> {head} → {base} birleştir
          </button>
        )}
      </div>
      {base === head ? (
        <Empty title="Aynı branch seçildi">Karşılaştırmak için iki farklı branch seçin.</Empty>
      ) : (
        <Async q={q} rows={4}>
          {(c) => (
            <>
              <p className="small muted">
                <b>{head}</b>, <b>{base}</b> branch&apos;inden {c.ahead} commit önde, {c.behind} commit geride · {c.files.length} dosya değişti
                {isAi && ' · AI branch’leri ilgili AI görevi ekranından onaylanarak birleştirilir.'}
              </p>
              {c.commits.length > 0 && (
                <Panel title="Commit'ler" flush className="mt">
                  {c.commits.map((x) => (
                    <button key={x.sha} className="list-item" style={{ width: '100%', background: 'none', border: 0, borderBottom: '1px solid var(--line)', cursor: 'pointer', textAlign: 'left', font: 'inherit' }} onClick={() => onOpen(x.sha)}>
                      <span className="mono small muted">{shortSha(x.sha)}</span>
                      <span className="ellipsis" style={{ flex: 1 }}>
                        {x.subject}
                      </span>
                      <span className="small muted">
                        {x.authorName} · {ago(x.date)}
                      </span>
                    </button>
                  ))}
                </Panel>
              )}
              <div className="mt">
                <DiffView patch={c.patch} maxHeight={640} />
                {c.truncated && <p className="small muted">Fark çok büyük; ilk kısmı gösteriliyor.</p>}
              </div>
            </>
          )}
        </Async>
      )}
      {merging && (
        <ConfirmDialog
          title="Branch'leri birleştir"
          message={
            <>
              <span className="tag">{head}</span> branch&apos;i <span className="tag">{base}</span> branch&apos;ine birleştirilecek. Çakışma varsa işlem yapılmaz; çakışmayı yerelde çözüp gönderin.
            </>
          }
          actionLabel="Birleştir"
          danger={false}
          busy={merge.isPending}
          onConfirm={() => merge.mutate()}
          onClose={() => setMerging(false)}
        />
      )}
    </>
  );
}

function CommitDrawer({ slug, sha, onClose }: { slug: string; sha: string; onClose: () => void }) {
  const q = useQuery({ queryKey: ['repo', slug, 'commit', sha], queryFn: () => api<CommitDetail>(`/projects/${slug}/repo/commits/${sha}`) });
  return (
    <Drawer title={<span className="mono">{shortSha(sha)}</span>} onClose={onClose} wide>
      <Async q={q}>
        {(c) => (
          <>
            <h3 style={{ margin: '0 0 4px' }}>{c.subject}</h3>
            {c.body && <pre className="small" style={{ whiteSpace: 'pre-wrap', margin: '0 0 8px' }}>{c.body}</pre>}
            <p className="small muted">
              {c.authorName} &lt;{c.authorEmail}&gt; · {dateTime(c.date)} · <span className="mono">{c.sha}</span>
            </p>
            <div className="row" style={{ marginBottom: 10 }}>
              <Link className="btn sm" href={`/projects/${slug}/code?ref=${c.sha}`}>
                Bu commit&apos;teki kodu gör
              </Link>
            </div>
            <div className="small" style={{ marginBottom: 10 }}>
              {c.files.map((f) => (
                <div key={f.path} className="mono">
                  <span style={{ color: 'var(--ok)' }}>+{f.additions}</span> <span style={{ color: 'var(--bad)' }}>−{f.deletions}</span> {f.path}
                  {f.binary && ' (ikili)'}
                </div>
              ))}
            </div>
            <DiffView patch={c.patch} maxHeight={900} />
            {c.truncated && <p className="small muted">Fark çok büyük; ilk kısmı gösteriliyor.</p>}
          </>
        )}
      </Async>
    </Drawer>
  );
}
