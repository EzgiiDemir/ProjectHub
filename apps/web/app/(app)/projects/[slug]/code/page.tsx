'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Bot, ChevronDown, ChevronRight, Download, FilePlus, GitCommitHorizontal, Search, Trash2, X } from 'lucide-react';
import dynamic from 'next/dynamic';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { api, ApiError, errorMessage } from '@/lib/api';
import { ago, bytes, shortSha } from '@/lib/format';
import { useProject, useProjectSlug } from '@/lib/hooks';
import type { Branches, RepoFile } from '@/lib/types';
import { AiChat } from '@/components/ai-chat';
import { Empty, ErrorState, Field, Loading, Modal } from '@/components/ui';
import { useToast } from '@/components/toast';

const CodeEditor = dynamic(() => import('@/components/code-editor').then((m) => m.CodeEditor), { ssr: false, loading: () => <Loading label="Editör yükleniyor…" /> });

interface Buffer {
  original: string | null; // null = new file
  current: string;
  language: string;
  binary: boolean;
  tooLarge: boolean;
  size: number;
  lastCommit: RepoFile['lastCommit'];
}
type TreeNode = { name: string; path: string; dir: boolean; children: TreeNode[] };

function buildTree(paths: string[]): TreeNode[] {
  const root: TreeNode = { name: '', path: '', dir: true, children: [] };
  for (const p of paths) {
    const parts = p.split('/');
    let node = root;
    parts.forEach((part, i) => {
      const path = parts.slice(0, i + 1).join('/');
      const dir = i < parts.length - 1;
      let child = node.children.find((c) => c.name === part && c.dir === dir);
      if (!child) {
        child = { name: part, path, dir, children: [] };
        node.children.push(child);
      }
      node = child;
    });
  }
  const sort = (n: TreeNode) => {
    n.children.sort((a, b) => (a.dir === b.dir ? a.name.localeCompare(b.name, 'tr') : a.dir ? -1 : 1));
    n.children.forEach(sort);
  };
  sort(root);
  return root.children;
}

const languageOf = (path: string) => {
  const ext = /\.([a-z0-9]+)$/i.exec(path)?.[1]?.toLowerCase() ?? '';
  const map: Record<string, string> = { ts: 'typescript', tsx: 'tsx', js: 'javascript', mjs: 'javascript', cjs: 'javascript', jsx: 'jsx', json: 'json', md: 'markdown', css: 'css', scss: 'scss', html: 'html', htm: 'html', yml: 'yaml', yaml: 'yaml', php: 'php', py: 'python', sql: 'sql', xml: 'xml', vue: 'vue' };
  return map[ext] ?? 'text';
};

/** In-browser code editor (spec §31–35): browse any branch, edit, and commit through the hub's Git server. */
export default function CodePage() {
  const slug = useProjectSlug();
  const params = useSearchParams();
  const router = useRouter();
  const toast = useToast();
  const qc = useQueryClient();
  const project = useProject().data;
  const branches = useQuery({ queryKey: ['repo', slug, 'branches'], queryFn: () => api<Branches>(`/projects/${slug}/repo/branches`) });
  const ref = params.get('ref') ?? branches.data?.defaultBranch ?? project?.defaultBranch ?? 'main';
  const isBranch = !!branches.data?.branches.some((b) => b.name === ref);
  const files = useQuery({ queryKey: ['repo', slug, 'files', ref], queryFn: () => api<{ commit: string | null; files: { path: string; size: number }[] }>(`/projects/${slug}/repo/files?ref=${encodeURIComponent(ref)}`), enabled: !!branches.data });

  const [tabs, setTabs] = useState<string[]>([]);
  const [active, setActive] = useState<string | null>(null);
  const [buffers, setBuffers] = useState<Record<string, Buffer>>({});
  const [deleted, setDeleted] = useState<Set<string>>(new Set());
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [filter, setFilter] = useState('');
  const [grep, setGrep] = useState<string | null>(null);
  const [aiOpen, setAiOpen] = useState(false);
  const [committing, setCommitting] = useState(false);
  const [creating, setCreating] = useState(false);
  const [cursor, setCursor] = useState<[number, number]>([1, 1]);
  const [revealLine, setRevealLine] = useState<number | null>(null);

  const canEdit = isBranch && !ref.startsWith('ai/') && !!project?.permissions.includes('repository.push') && project.status !== 'archived';
  const dirty = useMemo(() => Object.entries(buffers).filter(([, b]) => b.original !== b.current).map(([p]) => p), [buffers]);
  const changes = dirty.length + deleted.size;

  // Branch switch: drop buffers (they belong to another commit). Unsaved work is guarded below.
  const switchRef = (next: string) => {
    if (changes && !window.confirm(`${changes} kaydedilmemiş değişiklik kaybolacak. Devam edilsin mi?`)) return;
    setBuffers({});
    setDeleted(new Set());
    setTabs([]);
    setActive(null);
    router.replace(`/projects/${slug}/code?ref=${encodeURIComponent(next)}`);
  };

  const openFile = useCallback(
    async (path: string, line?: number) => {
      setTabs((t) => (t.includes(path) ? t : [...t, path]));
      setActive(path);
      setRevealLine(line ?? null);
      const parts = path.split('/');
      setExpanded((e) => new Set([...e, ...parts.slice(0, -1).map((_, i) => parts.slice(0, i + 1).join('/'))]));
      if (buffers[path]) return;
      try {
        const f = await api<RepoFile>(`/projects/${slug}/repo/file?ref=${encodeURIComponent(ref)}&path=${encodeURIComponent(path)}`);
        setBuffers((b) => (b[path] ? b : { ...b, [path]: { original: f.content ?? '', current: f.content ?? '', language: f.language, binary: f.binary, tooLarge: f.tooLarge, size: f.size, lastCommit: f.lastCommit } }));
      } catch (e) {
        toast(errorMessage(e), 'bad');
        setTabs((t) => t.filter((x) => x !== path));
      }
    },
    [buffers, ref, slug, toast],
  );

  // Deep links: ?path=…&line=… (from build errors, AI citations, feedback related files).
  const linkPath = params.get('path');
  const linkLine = Number(params.get('line')) || undefined;
  useEffect(() => {
    if (linkPath && files.data) void openFile(linkPath, linkLine);
    else if (!linkPath && files.data && !active) {
      const readme = files.data.files.find((f) => /^readme\.md$/i.test(f.path));
      if (readme) void openFile(readme.path);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [linkPath, linkLine, files.data]);

  useEffect(() => {
    const h = (e: BeforeUnloadEvent) => {
      if (changes) e.preventDefault();
    };
    window.addEventListener('beforeunload', h);
    return () => window.removeEventListener('beforeunload', h);
  }, [changes]);

  const closeTab = (path: string) => {
    const b = buffers[path];
    if (b && b.original !== b.current && !window.confirm(`${path} kaydedilmedi. Değişiklik atılsın mı?`)) return;
    setTabs((t) => t.filter((x) => x !== path));
    setBuffers((all) => {
      const { [path]: _, ...rest } = all;
      return rest;
    });
    if (active === path) setActive(tabs.filter((x) => x !== path).at(-1) ?? null);
  };

  const allPaths = useMemo(() => {
    const set = new Set((files.data?.files ?? []).map((f) => f.path));
    for (const [p, b] of Object.entries(buffers)) if (b.original === null) set.add(p);
    for (const p of deleted) set.delete(p);
    return [...set];
  }, [files.data, buffers, deleted]);
  const tree = useMemo(() => buildTree(filter ? allPaths.filter((p) => p.toLowerCase().includes(filter.toLowerCase())) : allPaths), [allPaths, filter]);
  const onCursor = useCallback((l: number, c: number) => setCursor([l, c]), []);

  if (branches.isLoading || files.isLoading) return <Loading rows={6} />;
  if (branches.error || files.error) return <ErrorState error={branches.error ?? files.error} onRetry={() => void files.refetch()} />;
  if (!files.data?.commit)
    return (
      <Empty title="Repository boş">
        Kodu Git ile gönderin: <code>git push {project?.repository?.cloneUrl} {project?.defaultBranch}</code>
      </Empty>
    );

  const buf = active ? buffers[active] : undefined;
  const renderNode = (n: TreeNode, depth: number): React.ReactNode =>
    n.dir ? (
      <div key={n.path}>
        <div className="d" style={{ paddingLeft: 8 + depth * 12 }} onClick={() => setExpanded((e) => (e.has(n.path) ? new Set([...e].filter((x) => x !== n.path)) : new Set([...e, n.path])))}>
          {expanded.has(n.path) || filter ? <ChevronDown size={12} /> : <ChevronRight size={12} />} {n.name}
        </div>
        {(expanded.has(n.path) || filter) && n.children.map((c) => renderNode(c, depth + 1))}
      </div>
    ) : (
      <button key={n.path} className={`f ${active === n.path ? 'on' : ''}`} style={{ paddingLeft: 20 + depth * 12 }} onClick={() => void openFile(n.path)} title={n.path}>
        {n.name}
        {buffers[n.path] && buffers[n.path]!.original !== buffers[n.path]!.current && <span className="mod">{buffers[n.path]!.original === null ? 'Y' : 'D'}</span>}
      </button>
    );

  return (
    <>
      <div className="row" style={{ marginBottom: 10 }}>
        <select className="in" style={{ width: 'auto' }} value={ref} onChange={(e) => switchRef(e.target.value)} aria-label="Branch">
          {branches.data?.branches.map((b) => (
            <option key={b.name} value={b.name}>
              {b.name}
            </option>
          ))}
          {!isBranch && <option value={ref}>{shortSha(ref)} (commit)</option>}
        </select>
        <span className="small muted">
          <span className="mono">{shortSha(files.data.commit)}</span> · {files.data.files.length} dosya
        </span>
        {!canEdit && <span className="small muted">· salt okunur{ref.startsWith('ai/') ? ' (AI branch’leri AI görevinden onaylanır)' : !isBranch ? ' (commit görüntüleniyor)' : ''}</span>}
        <div style={{ flex: 1 }} />
        {canEdit && (
          <button className="btn" onClick={() => setCreating(true)}>
            <FilePlus /> Yeni dosya
          </button>
        )}
        {canEdit && (
          <button className="btn pri" disabled={!changes} onClick={() => setCommitting(true)}>
            <GitCommitHorizontal /> Commit{changes ? ` (${changes})` : ''}
          </button>
        )}
        <button className={`btn ${aiOpen ? 'pri' : ''}`} onClick={() => setAiOpen((v) => !v)}>
          <Bot /> AI
        </button>
      </div>
      <div className={`ide ${aiOpen ? 'with-ai' : ''}`}>
        <div className="tree">
          <div style={{ padding: '0 4px 6px', display: 'flex', gap: 4 }}>
            <input className="in" style={{ padding: '4px 8px', fontSize: 12.5 }} placeholder="Dosya filtrele" value={filter} onChange={(e) => setFilter(e.target.value)} />
            <button className={`icon-btn ${grep !== null ? 'on' : ''}`} title="Kodda ara" onClick={() => setGrep((g) => (g === null ? '' : null))}>
              <Search size={15} />
            </button>
          </div>
          {grep !== null ? <GrepPanel slug={slug} refName={ref} onOpen={(p, l) => void openFile(p, l)} /> : tree.map((n) => renderNode(n, 0))}
        </div>
        <div className="ed-col">
          <div className="ed-tabs">
            {tabs.map((t) => (
              <div key={t} className={`ed-tab ${active === t ? 'on' : ''}`} onClick={() => setActive(t)}>
                {buffers[t] && buffers[t]!.original !== buffers[t]!.current && <span className="dm" />}
                {t.split('/').pop()}
                <button
                  className="x"
                  aria-label="Kapat"
                  onClick={(e) => {
                    e.stopPropagation();
                    closeTab(t);
                  }}
                >
                  <X size={12} />
                </button>
              </div>
            ))}
          </div>
          {active && (
            <div className="ed-tool small">
              <span className="mono">{active}</span>
              {buf?.lastCommit && (
                <span className="muted">
                  · son değişiklik {buf.lastCommit.authorName}, {ago(buf.lastCommit.date)} — {buf.lastCommit.subject}
                </span>
              )}
              <div style={{ flex: 1 }} />
              <a className="btn sm ghost" href={`/api/v1/projects/${slug}/repo/raw?ref=${encodeURIComponent(ref)}&path=${encodeURIComponent(active)}`} title="İndir">
                <Download size={14} />
              </a>
              {canEdit && buf?.original !== null && (
                <button
                  className="btn sm ghost"
                  title="Dosyayı sil"
                  onClick={() => {
                    if (!window.confirm(`${active} silinsin mi? Commit ettiğinizde silinir.`)) return;
                    setDeleted((d) => new Set([...d, active]));
                    closeTab(active);
                  }}
                >
                  <Trash2 size={14} />
                </button>
              )}
            </div>
          )}
          <div className="ed-body">
            {!active ? (
              <Empty title="Dosya seçin">Soldaki ağaçtan bir dosya açın.</Empty>
            ) : !buf ? (
              <Loading />
            ) : buf.binary || buf.tooLarge ? (
              <Empty title={buf.binary ? 'İkili dosya' : 'Dosya çok büyük'}>{bytes(buf.size)} · indirerek görüntüleyebilirsiniz.</Empty>
            ) : (
              <CodeEditor
                key={`${ref}:${active}`}
                value={buf.current}
                language={buf.language}
                readOnly={!canEdit}
                line={revealLine}
                onCursor={onCursor}
                onChange={(v) => setBuffers((b) => ({ ...b, [active]: { ...b[active]!, current: v } }))}
              />
            )}
          </div>
          <div className="ed-status">
            <span>{buf?.language ?? ''}</span>
            <span>
              Satır {cursor[0]}, Sütun {cursor[1]}
            </span>
            <span>{changes ? `${changes} kaydedilmemiş değişiklik` : 'Değişiklik yok'}</span>
            <span>UTF-8 · LF</span>
          </div>
        </div>
        {aiOpen && (
          <div className="ai-side">
            <div className="panel-h">
              <h2 style={{ fontSize: 14 }}>Proje AI</h2>
            </div>
            <AiChat slug={slug} filePath={active} compact placeholder="Bu dosya hakkında sorun…" suggestions={active ? ['Bu dosya ne yapıyor?', 'Bu dosyada olası hatalar var mı?', 'Bu dosyayı kimler kullanıyor?'] : []} />
          </div>
        )}
      </div>
      {creating && (
        <NewFile
          existing={allPaths}
          onClose={() => setCreating(false)}
          onCreate={(path) => {
            setBuffers((b) => ({ ...b, [path]: { original: null, current: '', language: languageOf(path), binary: false, tooLarge: false, size: 0, lastCommit: null } }));
            setDeleted((d) => new Set([...d].filter((x) => x !== path)));
            setTabs((t) => [...t, path]);
            setActive(path);
            setCreating(false);
          }}
        />
      )}
      {committing && (
        <CommitDialog
          slug={slug}
          branch={ref}
          baseCommit={files.data.commit}
          dirty={dirty}
          deleted={[...deleted]}
          buffers={buffers}
          onClose={() => setCommitting(false)}
          onDone={(sha) => {
            toast(`Commit ${shortSha(sha)} gönderildi`);
            setCommitting(false);
            setDeleted(new Set());
            setBuffers((all) => Object.fromEntries(Object.entries(all).map(([p, b]) => [p, { ...b, original: b.current }])));
            void qc.invalidateQueries({ queryKey: ['repo', slug] });
            void qc.invalidateQueries({ queryKey: ['project', slug] });
          }}
          onConflict={() => {
            void qc.invalidateQueries({ queryKey: ['repo', slug] });
          }}
        />
      )}
    </>
  );
}

function GrepPanel({ slug, refName, onOpen }: { slug: string; refName: string; onOpen: (path: string, line: number) => void }) {
  const [q, setQ] = useState('');
  const [submitted, setSubmitted] = useState('');
  const r = useQuery({
    queryKey: ['repo', slug, 'search', refName, submitted],
    queryFn: () => api<{ path: string; line: number; text: string }[]>(`/projects/${slug}/repo/search?ref=${encodeURIComponent(refName)}&q=${encodeURIComponent(submitted)}`),
    enabled: submitted.length >= 2,
  });
  return (
    <div style={{ padding: '0 4px' }}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          setSubmitted(q.trim());
        }}
      >
        <input className="in" style={{ padding: '4px 8px', fontSize: 12.5 }} placeholder="Kodda ara, Enter" value={q} onChange={(e) => setQ(e.target.value)} autoFocus />
      </form>
      {r.isFetching && <Loading />}
      {r.error && <div className="small" style={{ color: 'var(--bad)', padding: 6 }}>{errorMessage(r.error)}</div>}
      {r.data && !r.data.length && <div className="small muted" style={{ padding: 6 }}>Sonuç yok</div>}
      {r.data?.map((m, i) => (
        <button key={i} className="f" style={{ display: 'block', whiteSpace: 'normal' }} onClick={() => onOpen(m.path, m.line)}>
          <div className="mono" style={{ fontSize: 11.5 }}>
            {m.path}:{m.line}
          </div>
          <div className="mono muted ellipsis" style={{ fontSize: 11.5 }}>
            {m.text.trim()}
          </div>
        </button>
      ))}
    </div>
  );
}

function NewFile({ existing, onClose, onCreate }: { existing: string[]; onClose: () => void; onCreate: (path: string) => void }) {
  const [path, setPath] = useState('');
  const clean = path.trim().replace(/^\/+/, '');
  const error = !clean ? null : existing.includes(clean) ? 'Bu yolda bir dosya var' : /(^|\/)\.\.(\/|$)|^\.git(\/|$)|\/$/.test(clean) ? 'Geçersiz dosya yolu' : null;
  return (
    <Modal
      title="Yeni dosya"
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            Vazgeç
          </button>
          <button className="btn pri" disabled={!clean || !!error} onClick={() => onCreate(clean)}>
            Oluştur
          </button>
        </>
      }
    >
      <Field label="Dosya yolu" id="nf-path" hint="Klasörler otomatik oluşturulur, ör. src/pages/iletisim.html" error={error}>
        <input id="nf-path" className="in mono" value={path} onChange={(e) => setPath(e.target.value)} autoFocus />
      </Field>
    </Modal>
  );
}

function CommitDialog({
  slug,
  branch,
  baseCommit,
  dirty,
  deleted,
  buffers,
  onClose,
  onDone,
  onConflict,
}: {
  slug: string;
  branch: string;
  baseCommit: string;
  dirty: string[];
  deleted: string[];
  buffers: Record<string, Buffer>;
  onClose: () => void;
  onDone: (sha: string) => void;
  onConflict: () => void;
}) {
  const [message, setMessage] = useState(dirty.length === 1 && !deleted.length ? `${dirty[0]} güncellendi` : '');
  const commit = useMutation({
    mutationFn: () =>
      api<{ commit: string }>(`/projects/${slug}/repo/commits`, {
        method: 'POST',
        body: {
          branch,
          baseCommit,
          message,
          changes: [...dirty.map((path) => ({ action: 'upsert' as const, path, content: buffers[path]!.current })), ...deleted.map((path) => ({ action: 'delete' as const, path }))],
        },
      }),
    onSuccess: (r) => onDone(r.commit),
    onError: (e) => e instanceof ApiError && e.status === 409 && onConflict(),
  });
  const conflict = commit.error instanceof ApiError && commit.error.status === 409;
  return (
    <Modal
      title={`${branch} branch'ine commit`}
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            Vazgeç
          </button>
          <button className="btn pri" disabled={!message.trim() || commit.isPending || conflict} onClick={() => commit.mutate()}>
            {commit.isPending && <span className="spinner" />} Commit et
          </button>
        </>
      }
    >
      <Field label="Commit mesajı" id="cm-msg">
        <textarea id="cm-msg" className="in" value={message} onChange={(e) => setMessage(e.target.value)} maxLength={500} autoFocus />
      </Field>
      <div className="small" style={{ marginBottom: 10 }}>
        {dirty.map((p) => (
          <div key={p} className="mono">
            <span style={{ color: buffers[p]!.original === null ? 'var(--ok)' : 'var(--amber)' }}>{buffers[p]!.original === null ? 'Y' : 'D'}</span> {p}
          </div>
        ))}
        {deleted.map((p) => (
          <div key={p} className="mono">
            <span style={{ color: 'var(--bad)' }}>S</span> {p}
          </div>
        ))}
      </div>
      <p className="small muted">Varsayılan branch&apos;e yapılan commit kod indeksini ve güvenlik taramasını yeniler. Build&apos;i Build&apos;ler ekranından başlatırsınız.</p>
      {commit.error && (
        <div className="badbox">
          {errorMessage(commit.error)}
          {conflict && (
            <div style={{ marginTop: 6 }}>
              Siz düzenlerken branch ilerledi. Değişikliklerinizi kopyalayın, sayfayı yenileyip yeniden uygulayın veya <Link href={`/projects/${slug}/git`}>yeni bir branch</Link> açın.
            </div>
          )}
        </div>
      )}
    </Modal>
  );
}
