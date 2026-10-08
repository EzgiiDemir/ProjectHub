'use client';

import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { api } from '@/lib/api';
import { ago } from '@/lib/format';
import { useProjectSlug } from '@/lib/hooks';
import type { RepoFile, Version } from '@/lib/types';
import { Async, Empty, Markdown, Panel } from '@/components/ui';

const RELEASES = '__releases__';

/** Project documentation lives in the repository (README, docs/*.md) so it is versioned with the code (spec §109). */
export default function DocsPage() {
  const slug = useProjectSlug();
  const params = useSearchParams();
  const router = useRouter();
  const files = useQuery({ queryKey: ['repo', slug, 'files', ''], queryFn: () => api<{ commit: string | null; files: { path: string }[] }>(`/projects/${slug}/repo/files`) });
  const docs = (files.data?.files ?? [])
    .map((f) => f.path)
    .filter((p) => /\.(md|markdown)$/i.test(p) && !/(^|\/)node_modules\//.test(p))
    .sort((a, b) => rank(a) - rank(b) || a.localeCompare(b, 'tr'));
  const selected = params.get('doc') ?? docs[0] ?? RELEASES;

  return (
    <>
      <div style={{ marginBottom: 12 }}>
        <h2 style={{ margin: 0 }}>Dokümantasyon</h2>
        <p className="sub">
          Dokümanlar repository&apos;de tutulur (README.md ve docs/ klasörü) ve kodla birlikte sürümlenir. Düzenlemek için <Link href={`/projects/${slug}/code?path=${encodeURIComponent(selected === RELEASES ? 'README.md' : selected)}`}>kod editörünü</Link> kullanın.
        </p>
      </div>
      <div className="grid" style={{ gridTemplateColumns: '240px minmax(0, 1fr)', alignItems: 'start' }}>
        <Panel flush>
          <div className="dev-list" style={{ padding: 6 }}>
            {docs.map((d) => (
              <button key={d} className={selected === d ? 'on' : ''} onClick={() => router.replace(`/projects/${slug}/docs?doc=${encodeURIComponent(d)}`)} title={d}>
                <span className="ellipsis">{d}</span>
              </button>
            ))}
            <button className={selected === RELEASES ? 'on' : ''} onClick={() => router.replace(`/projects/${slug}/docs?doc=${RELEASES}`)}>
              <span>Sürüm notları</span>
            </button>
          </div>
        </Panel>
        <Panel>{selected === RELEASES ? <Releases slug={slug} /> : <Doc slug={slug} path={selected} />}</Panel>
      </div>
    </>
  );
}

function rank(p: string) {
  if (/^readme\.md$/i.test(p)) return 0;
  if (/^docs\//i.test(p)) return 1;
  if (!p.includes('/')) return 2;
  return 3;
}

function Doc({ slug, path }: { slug: string; path: string }) {
  const q = useQuery({ queryKey: ['repo', slug, 'file', '', path], queryFn: () => api<RepoFile>(`/projects/${slug}/repo/file?path=${encodeURIComponent(path)}`) });
  return (
    <Async q={q}>
      {(f) => (
        <>
          {f.lastCommit && (
            <p className="small muted" style={{ marginTop: 0 }}>
              <span className="mono">{path}</span> · son değişiklik {f.lastCommit.authorName}, {ago(f.lastCommit.date)}
            </p>
          )}
          {f.content !== null ? <Markdown text={f.content} /> : <Empty title="Görüntülenemiyor" />}
        </>
      )}
    </Async>
  );
}

function Releases({ slug }: { slug: string }) {
  const q = useQuery({ queryKey: ['versions', slug], queryFn: () => api<Version[]>(`/projects/${slug}/versions`) });
  return (
    <Async q={q}>
      {(rows) =>
        rows.length ? (
          <div className="prose">
            {rows.map((v) => (
              <section key={v.id}>
                <h2>
                  v{v.version} <span className="small muted">{ago(v.createdAt)}</span>
                </h2>
                <Markdown text={v.releaseNotes || '_Sürüm notu yok._'} />
              </section>
            ))}
          </div>
        ) : (
          <Empty title="Henüz versiyon yok" />
        )
      }
    </Async>
  );
}
