'use client';

import { useMutation, useQuery } from '@tanstack/react-query';
import { zip, type Zippable } from 'fflate';
import { FileArchive, FolderUp, GitBranch, Sparkles } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useRef, useState } from 'react';
import type { DetectionResult, ProjectTemplateId } from '@projecthub/contracts';
import { api, ApiError, errorMessage } from '@/lib/api';
import { bytes } from '@/lib/format';
import { useCan } from '@/lib/hooks';
import type { ProjectSummary } from '@/lib/types';
import { Field, KeyValue, PageHeader, Panel } from '@/components/ui';

type Source = 'upload' | 'git' | 'empty';
interface TemplateInfo {
  id: ProjectTemplateId;
  name: string;
  description: string;
  technologies: string[];
  requires: string;
}
interface UploadResult {
  uploadId: string;
  fileCount: number;
  skipped: number;
  bytes: number;
  detection: DetectionResult;
  suggested: { name: string; slug: string; description: string };
  sample: string[];
}

/** Folders that are rebuilt by the build pipeline and only bloat an import. */
const SKIP_DIRS = /(^|\/)(node_modules|\.git|\.next|\.nuxt|dist|build|vendor|__pycache__|\.venv|venv|\.cache|coverage)(\/|$)/;
const COLORS = ['#234E8C', '#1F7A55', '#B5541C', '#7A3EA8', '#2E6F7E', '#9C2F4F', '#5B6772'];

const TR: Record<string, string> = { ğ: 'g', ü: 'u', ş: 's', ı: 'i', ö: 'o', ç: 'c', Ğ: 'g', Ü: 'u', Ş: 's', İ: 'i', Ö: 'o', Ç: 'c' };
const slugify = (s: string) =>
  s
    .replace(/[ğüşıöçĞÜŞİÖÇ]/g, (c) => TR[c] ?? c)
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);

/** Smart Import (spec §14–24): bring an existing project in from a folder, ZIP or Git URL, or start empty. */
export default function NewProjectPage() {
  const router = useRouter();
  const can = useCan();
  const teams = useQuery({ queryKey: ['teams'], queryFn: () => api<{ id: string; name: string }[]>('/admin/teams') });
  const [source, setSource] = useState<Source>('upload');
  const [upload, setUpload] = useState<UploadResult | null>(null);
  const [progress, setProgress] = useState<{ phase: 'zip' | 'upload'; pct: number; label: string } | null>(null);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [git, setGit] = useState({ url: '', branch: '', token: '' });
  const [template, setTemplate] = useState<ProjectTemplateId>('static');
  const templates = useQuery({ queryKey: ['projectTemplates'], queryFn: () => api<TemplateInfo[]>('/project-templates'), staleTime: Infinity });
  const [form, setForm] = useState({ name: '', slug: '', description: '', customerName: '', teamId: '', color: COLORS[0]!, defaultBranch: 'main', createDefaultEnvironments: true });
  const [slugTouched, setSlugTouched] = useState(false);
  const folderInput = useRef<HTMLInputElement>(null);
  const zipInput = useRef<HTMLInputElement>(null);

  const setName = (name: string) => setForm((f) => ({ ...f, name, slug: slugTouched ? f.slug : slugify(name) }));

  const sendZip = (blob: Blob, fileName: string) =>
    new Promise<UploadResult>((resolve, reject) => {
      // XHR (not fetch) for upload progress.
      const xhr = new XMLHttpRequest();
      xhr.open('POST', '/api/v1/uploads');
      xhr.setRequestHeader('content-type', 'application/zip');
      xhr.setRequestHeader('x-file-name', encodeURIComponent(fileName));
      xhr.setRequestHeader('x-requested-with', 'projecthub');
      xhr.upload.onprogress = (e) => e.lengthComputable && setProgress({ phase: 'upload', pct: Math.round((e.loaded / e.total) * 100), label: `Yükleniyor · ${bytes(e.loaded)} / ${bytes(e.total)}` });
      xhr.onload = () => {
        let json: { data?: UploadResult; error?: { message: string } } = {};
        try {
          json = JSON.parse(xhr.responseText || '{}');
        } catch {
          // A proxy or gateway answered with a non-JSON error page.
        }
        if (xhr.status >= 200 && xhr.status < 300 && json.data) resolve(json.data);
        else if (xhr.status === 413) reject(new Error('Dosya çok büyük (en fazla 300 MB). node_modules gibi klasörleri dışarıda bırakın.'));
        else reject(new Error(json.error?.message ?? `Yükleme başarısız (HTTP ${xhr.status}). Lütfen tekrar deneyin.`));
      };
      xhr.onerror = () => reject(new Error('Sunucuya ulaşılamadı'));
      xhr.send(blob);
    });

  const accept = (r: UploadResult) => {
    setUpload(r);
    setForm((f) => ({ ...f, name: f.name || r.suggested.name, slug: slugTouched ? f.slug : r.suggested.slug, description: f.description || r.suggested.description }));
  };

  const onFolder = async (files: FileList | null) => {
    if (!files?.length) return;
    setUploadError(null);
    setUpload(null);
    try {
      const list = [...files].filter((f) => !SKIP_DIRS.test(f.webkitRelativePath));
      const root = list[0]?.webkitRelativePath.split('/')[0] ?? 'proje';
      const entries: Zippable = {};
      let done = 0;
      for (const f of list) {
        entries[f.webkitRelativePath] = new Uint8Array(await f.arrayBuffer());
        done++;
        if (done % 50 === 0) setProgress({ phase: 'zip', pct: Math.round((done / list.length) * 100), label: `Dosyalar okunuyor · ${done}/${list.length}` });
      }
      setProgress({ phase: 'zip', pct: 100, label: `Sıkıştırılıyor · ${list.length} dosya` });
      const data = await new Promise<Uint8Array>((res, rej) => zip(entries, { level: 6 }, (err, out) => (err ? rej(err) : res(out))));
      accept(await sendZip(new Blob([data as BlobPart], { type: 'application/zip' }), `${root}.zip`));
    } catch (e) {
      setUploadError(errorMessage(e));
    } finally {
      setProgress(null);
    }
  };

  const onZip = async (file: File | undefined) => {
    if (!file) return;
    setUploadError(null);
    setUpload(null);
    try {
      accept(await sendZip(file, file.name));
    } catch (e) {
      setUploadError(errorMessage(e));
    } finally {
      setProgress(null);
    }
  };

  const create = useMutation({
    mutationFn: () =>
      api<ProjectSummary>('/projects', {
        method: 'POST',
        body: {
          name: form.name,
          slug: form.slug,
          description: form.description,
          customerName: form.customerName,
          teamId: form.teamId || null,
          color: form.color,
          defaultBranch: form.defaultBranch,
          createDefaultEnvironments: form.createDefaultEnvironments,
          source: source === 'upload' ? { type: 'upload', uploadId: upload!.uploadId } : source === 'git' ? { type: 'git', url: git.url.trim(), branch: git.branch.trim() || undefined, accessToken: git.token.trim() || undefined } : { type: 'empty', template },
        },
      }),
    onSuccess: (p) => router.push(`/projects/${p.slug}`),
  });
  const slugTaken = create.error instanceof ApiError && (create.error.details as { field?: string } | undefined)?.field === 'slug';
  const ready = form.name.trim() && /^[a-z0-9][a-z0-9-]*$/.test(form.slug) && (source === 'empty' || (source === 'git' && /^https?:\/\/.+/.test(git.url.trim())) || (source === 'upload' && upload));

  if (!can('project.create')) return <div className="page"><div className="badbox">Proje oluşturma yetkiniz yok.</div></div>;

  return (
    <div className="page" style={{ maxWidth: 1100 }}>
      <PageHeader title="Proje ekle / içe aktar" sub="Mevcut bir projeyi klasör, ZIP veya Git adresinden getirin; Project Hub teknolojiyi tanır, build ve ön izleme ayarlarını önerir." />
      <div className="grid g3" style={{ marginBottom: 14 }}>
        {(
          [
            ['upload', <FolderUp key="u" />, 'Klasör veya ZIP', 'Bilgisayarınızdaki proje klasörünü seçin'],
            ['git', <GitBranch key="g" />, 'Git deposu', 'GitHub, GitLab, Bitbucket veya herhangi bir Git adresi'],
            ['empty', <Sparkles key="e" />, 'Şablondan yeni proje', 'Next.js, React, Laravel, FastAPI, Node API veya statik site'],
          ] as [Source, React.ReactNode, string, string][]
        ).map(([k, icon, title, sub]) => (
          <button key={k} className="panel" style={{ padding: 16, textAlign: 'left', cursor: 'pointer', font: 'inherit', color: 'inherit', outline: source === k ? '2px solid var(--primary)' : undefined }} onClick={() => setSource(k)}>
            <div className="row" style={{ gap: 8, fontWeight: 600 }}>
              {icon} {title}
            </div>
            <div className="small muted" style={{ marginTop: 4 }}>
              {sub}
            </div>
          </button>
        ))}
      </div>
      <div className="grid split" style={{ alignItems: 'start' }}>
        <div className="grid" style={{ gap: 14 }}>
          {source === 'upload' && (
            <Panel title="Kaynak">
              <div className="row">
                <button className="btn pri" onClick={() => folderInput.current?.click()} disabled={!!progress}>
                  <FolderUp /> Klasör seç
                </button>
                <button className="btn" onClick={() => zipInput.current?.click()} disabled={!!progress}>
                  <FileArchive /> ZIP seç
                </button>
              </div>
              {/* webkitdirectory is not in React's input typings */}
              <input ref={folderInput} type="file" hidden multiple {...({ webkitdirectory: '', directory: '' } as Record<string, string>)} onChange={(e) => void onFolder(e.target.files)} />
              <input ref={zipInput} type="file" hidden accept=".zip,application/zip" onChange={(e) => void onZip(e.target.files?.[0])} />
              <p className="small muted">node_modules, .git, dist, build, vendor gibi yeniden üretilen klasörler alınmaz. En fazla 300 MB.</p>
              {progress && (
                <div style={{ marginTop: 10 }}>
                  <div className="small">{progress.label}</div>
                  <div className="bar" style={{ marginTop: 4 }}>
                    <i style={{ width: `${progress.pct}%` }} />
                  </div>
                </div>
              )}
              {uploadError && <div className="badbox" style={{ marginTop: 10 }}>{uploadError}</div>}
              {upload && (
                <div className="okbox small" style={{ marginTop: 10 }}>
                  {upload.fileCount} dosya alındı ({bytes(upload.bytes)}){upload.skipped ? ` · ${upload.skipped} dosya atlandı` : ''}.
                </div>
              )}
            </Panel>
          )}
          {source === 'empty' && (
            <Panel title="Şablon">
              <div className="grid g2">
                {templates.data?.map((t) => (
                  <button key={t.id} type="button" className="panel" style={{ padding: 12, textAlign: 'left', cursor: 'pointer', font: 'inherit', color: 'inherit', outline: template === t.id ? '2px solid var(--primary)' : undefined }} onClick={() => setTemplate(t.id)}>
                    <b>{t.name}</b>
                    <div className="small muted" style={{ marginTop: 4 }}>{t.description}</div>
                    {t.requires !== '—' && <div className="small" style={{ marginTop: 4 }}>Gerekli: {t.requires}</div>}
                  </button>
                ))}
              </div>
              <p className="small muted" style={{ marginBottom: 0 }}>Şablon; çalışan örnek kodu, testleri ve build/ön izleme/deployment ayarlarını (projecthub.yml) getirir.</p>
            </Panel>
          )}
          {source === 'git' && (
            <Panel title="Git deposu">
              <Field label="Depo adresi" id="np-url" hint="HTTPS adresi, ör. https://github.com/firma/proje.git">
                <input id="np-url" className="in mono" value={git.url} onChange={(e) => setGit((g) => ({ ...g, url: e.target.value }))} placeholder="https://github.com/…" />
              </Field>
              <div className="grid g2">
                <Field label="Branch (isteğe bağlı)" id="np-br" hint="Boşsa deponun varsayılan branch'i">
                  <input id="np-br" className="in mono" value={git.branch} onChange={(e) => setGit((g) => ({ ...g, branch: e.target.value }))} />
                </Field>
                <Field label="Erişim anahtarı (özel depolar)" id="np-tok" hint="Şifrelenerek saklanır, senkronizasyonda kullanılır">
                  <input id="np-tok" className="in" type="password" value={git.token} onChange={(e) => setGit((g) => ({ ...g, token: e.target.value }))} autoComplete="off" />
                </Field>
              </div>
              <p className="small muted" style={{ marginBottom: 0 }}>Depo arka planda klonlanır; teknoloji tespiti, kod indeksi ve güvenlik taraması ardından otomatik çalışır.</p>
            </Panel>
          )}
          <Panel title="Proje bilgileri">
            <div className="grid g2">
              <Field label="Proje adı" id="np-name">
                <input id="np-name" className="in" value={form.name} onChange={(e) => setName(e.target.value)} maxLength={150} />
              </Field>
              <Field label="Kısa ad" id="np-slug" hint="Adreslerde kullanılır; sonradan değişmez" error={slugTaken ? 'Bu kısa ad kullanılıyor' : form.slug && !/^[a-z0-9][a-z0-9-]*$/.test(form.slug) ? 'Küçük harf, rakam ve tire' : null}>
                <input
                  id="np-slug"
                  className="in mono"
                  value={form.slug}
                  onChange={(e) => {
                    setSlugTouched(true);
                    setForm((f) => ({ ...f, slug: e.target.value }));
                  }}
                  maxLength={80}
                />
              </Field>
            </div>
            <Field label="Açıklama" id="np-desc">
              <textarea id="np-desc" className="in" value={form.description} onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))} maxLength={2000} />
            </Field>
            <div className="grid g3">
              <Field label="Kullanıcı" id="np-cust">
                <input id="np-cust" className="in" value={form.customerName} onChange={(e) => setForm((f) => ({ ...f, customerName: e.target.value }))} maxLength={150} />
              </Field>
              <Field label="Ekip" id="np-team">
                <select id="np-team" className="in" value={form.teamId} onChange={(e) => setForm((f) => ({ ...f, teamId: e.target.value }))}>
                  <option value="">—</option>
                  {teams.data?.map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.name}
                    </option>
                  ))}
                </select>
              </Field>
              <div className="field">
                <label>Renk</label>
                <div className="row" style={{ gap: 6 }}>
                  {COLORS.map((c) => (
                    <button key={c} type="button" aria-label={c} onClick={() => setForm((f) => ({ ...f, color: c }))} style={{ width: 24, height: 24, borderRadius: 6, background: c, border: form.color === c ? '2px solid var(--ink)' : '2px solid transparent', cursor: 'pointer' }} />
                  ))}
                </div>
              </div>
            </div>
            {source === 'empty' && (
              <Field label="Varsayılan branch" id="np-db">
                <input id="np-db" className="in mono" value={form.defaultBranch} onChange={(e) => setForm((f) => ({ ...f, defaultBranch: e.target.value }))} style={{ maxWidth: 240 }} />
              </Field>
            )}
            <label className="check">
              <input type="checkbox" checked={form.createDefaultEnvironments} onChange={(e) => setForm((f) => ({ ...f, createDefaultEnvironments: e.target.checked }))} /> Development, Staging ve Production ortamlarını oluştur
            </label>
            {create.error && !slugTaken && <div className="badbox" style={{ marginTop: 10 }}>{errorMessage(create.error)}</div>}
            <div style={{ marginTop: 14 }}>
              <button className="btn pri" disabled={!ready || create.isPending} onClick={() => create.mutate()}>
                {create.isPending && <span className="spinner" />} {source === 'empty' ? 'Projeyi oluştur' : 'İçe aktar'}
              </button>
            </div>
          </Panel>
        </div>
        <DetectionPanel source={source} upload={upload} />
      </div>
    </div>
  );
}

function DetectionPanel({ source, upload }: { source: Source; upload: UploadResult | null }) {
  if (source !== 'upload' || !upload)
    return (
      <Panel title="Akıllı tespit">
        <p className="small muted" style={{ margin: 0 }}>
          {source === 'empty'
            ? 'Şablon projecthub.yml ile gelir; oluşturulduktan sonra ilk build’i başlatıp ön izleme açabilirsiniz.'
            : source === 'git'
              ? 'Depo klonlandıktan sonra teknoloji, build komutları ve veritabanı otomatik tespit edilir; sonucu proje ayarlarında görürsünüz.'
              : 'Klasörü seçtiğinizde proje türü, build komutları, port, veritabanı ve testler burada gösterilir.'}
        </p>
      </Panel>
    );
  const d = upload.detection;
  return (
    <Panel title="Akıllı tespit">
      <div style={{ fontWeight: 600, marginBottom: 6 }}>
        {d.projectType} {d.technologies.length > 0 && <span className="small muted">· {d.technologies.join(', ')}</span>}
      </div>
      <KeyValue
        items={[
          ['Çalışma ortamı', `${d.runtime.type}${d.runtime.version ? ` ${d.runtime.version}` : ''}`],
          ['Kurulum', <span key="i" className="mono small">{d.installCommand ?? '—'}</span>],
          ['Build', <span key="b" className="mono small">{d.buildCommand ?? '—'}</span>],
          ['Test', <span key="t" className="mono small">{d.testCommand ?? '—'}</span>],
          ['Ön izleme', d.previewMode === 'process' ? `Uygulama sunucusu${d.port ? ` · port ${d.port}` : ''}` : d.previewMode === 'static' ? `Statik${d.buildOutput ? ` · ${d.buildOutput}` : ''}` : 'yok'],
          ['Veritabanı', d.database === 'none' ? 'yok' : d.database],
          ['Ortam değişkenleri', d.envVars.length ? <span key="e" className="mono small">{d.envVars.join(', ')}</span> : '—'],
        ]}
      />
      {d.checks.length > 0 && (
        <div className="small" style={{ marginTop: 10 }}>
          {d.checks.map((c) => (
            <div key={c} style={{ color: 'var(--ok)' }}>
              ✓ {c}
            </div>
          ))}
        </div>
      )}
      {d.warnings.length > 0 && (
        <div className="warnbox small" style={{ marginTop: 10 }}>
          {d.warnings.map((w) => (
            <div key={w}>• {w}</div>
          ))}
        </div>
      )}
      <p className="small muted" style={{ marginBottom: 0 }}>
        {d.hasManifest ? 'Projedeki projecthub.yml kullanılacak.' : 'Bu tespitten bir manifest oluşturulup kullanılır; Ayarlar › projecthub.yml ekranında düzenleyip repository’ye kaydedebilirsiniz.'}
      </p>
    </Panel>
  );
}
