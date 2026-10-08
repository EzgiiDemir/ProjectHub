'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus } from 'lucide-react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useEffect, useState } from 'react';
import { api, apiPaged, errorMessage } from '@/lib/api';
import { ago, dateTime, shortSha } from '@/lib/format';
import { useProject, useProjectSlug } from '@/lib/hooks';
import type { Build, Comparison, Version } from '@/lib/types';
import { Async, Drawer, Empty, Field, Panel, StatusBadge } from '@/components/ui';
import { useToast } from '@/components/toast';

/** Versions (spec §80–82): an immutable, deployable snapshot of a successful build, with notes and migration risk. */
export default function VersionsPage() {
  const slug = useProjectSlug();
  const params = useSearchParams();
  const router = useRouter();
  const project = useProject().data;
  const q = useQuery({ queryKey: ['versions', slug], queryFn: () => api<Version[]>(`/projects/${slug}/versions`) });
  const canCreate = !!project?.permissions.includes('version.create') && project.status !== 'archived';
  const creating = params.get('new') === '1';

  return (
    <>
      <div className="spread" style={{ marginBottom: 12 }}>
        <div>
          <h2 style={{ margin: 0 }}>Versiyonlar</h2>
          <p className="sub">Versiyon, başarılı bir build&apos;in değişmez paketidir. Ortamlara her zaman bir versiyon yayınlanır.</p>
        </div>
        {canCreate && (
          <button className="btn pri" onClick={() => router.replace(`/projects/${slug}/versions?new=1`)}>
            <Plus /> Versiyon oluştur
          </button>
        )}
      </div>
      <Async q={q} rows={4}>
        {(rows) =>
          rows.length ? (
            <div className="grid" style={{ gap: 12 }}>
              {rows.map((v) => (
                <Panel
                  key={v.id}
                  title={
                    <span className="row" style={{ gap: 8 }}>
                      v{v.version} <StatusBadge status={v.status} />
                      {v.liveIn.map((e) => (
                        <span key={e} className="tag" style={{ color: 'var(--ok)' }}>
                          {e}
                        </span>
                      ))}
                    </span>
                  }
                  actions={
                    <span className="small muted">
                      <Link href={`/projects/${slug}/builds/${v.buildId}`}>Build #{v.buildNumber}</Link> · <span className="mono">{shortSha(v.commitSha)}</span> · {v.createdByName ?? '—'} · {ago(v.createdAt)}
                    </span>
                  }
                >
                  <div style={{ whiteSpace: 'pre-wrap', fontSize: 13.5 }}>{v.releaseNotes || <span className="muted">Sürüm notu yok.</span>}</div>
                  {v.migrations.length > 0 && (
                    <div style={{ marginTop: 10 }}>
                      <div className="small muted" style={{ marginBottom: 4 }}>
                        Veritabanı değişiklikleri
                      </div>
                      {v.migrations.map((m) => (
                        <div key={m.path} className="small row" style={{ gap: 6 }}>
                          <StatusBadge status={m.risk} label={m.risk === 'high' ? 'Yüksek risk' : m.risk === 'medium' ? 'Orta risk' : 'Düşük risk'} />
                          <span className="mono">{m.path}</span>
                          <span className="muted">{m.operations.join(', ')}</span>
                        </div>
                      ))}
                    </div>
                  )}
                  {v.releasedAt && <div className="small muted" style={{ marginTop: 8 }}>Son production yayını: {dateTime(v.releasedAt)}</div>}
                </Panel>
              ))}
            </div>
          ) : (
            <Empty title="Versiyon yok" action={canCreate && <button className="btn pri" onClick={() => router.replace(`/projects/${slug}/versions?new=1`)}>İlk versiyonu oluştur</button>}>
              Başarılı bir build&apos;den versiyon oluşturup ortamlara yayınlayabilirsiniz.
            </Empty>
          )
        }
      </Async>
      {creating && canCreate && <CreateVersion slug={slug} latest={q.data?.[0] ?? null} onClose={() => router.replace(`/projects/${slug}/versions`)} />}
    </>
  );
}

function nextPatch(v: string | undefined) {
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(v ?? '');
  return m ? `${m[1]}.${m[2]}.${Number(m[3]) + 1}` : '1.0.0';
}

function CreateVersion({ slug, latest, onClose }: { slug: string; latest: Version | null; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const project = useProject().data;
  const builds = useQuery({ queryKey: ['builds', slug, 'forVersion'], queryFn: () => apiPaged<Build>(`/projects/${slug}/builds?limit=50`) });
  const passed = (builds.data?.data ?? []).filter((b) => b.status === 'passed');
  const [buildId, setBuildId] = useState('');
  const build = passed.find((b) => b.id === buildId) ?? passed[0];
  const [version, setVersion] = useState(nextPatch(latest?.version ?? project?.currentVersion ?? undefined));
  const [notes, setNotes] = useState('');
  const [touched, setTouched] = useState(false);

  // Draft release notes from the commits since the previous version (editable).
  const changes = useQuery({
    queryKey: ['repo', slug, 'compare', latest?.commitSha, build?.commitSha],
    queryFn: () => api<Comparison>(`/projects/${slug}/repo/compare?base=${latest!.commitSha}&head=${build!.commitSha}`),
    enabled: !!latest && !!build && latest.commitSha !== build.commitSha,
  });
  useEffect(() => {
    if (touched) return;
    if (changes.data) setNotes(changes.data.commits.map((c) => `- ${c.subject}`).join('\n'));
    else if (build && !latest) setNotes(`- İlk sürüm (${build.commitMessage})`);
  }, [changes.data, build, latest, touched]);

  const create = useMutation({
    mutationFn: () => api<Version>(`/projects/${slug}/versions`, { method: 'POST', body: { version: version.trim(), buildId: build!.id, releaseNotes: notes } }),
    onSuccess: (v) => {
      toast(`v${v.version} oluşturuldu`);
      void qc.invalidateQueries({ queryKey: ['versions'] });
      onClose();
    },
  });
  const semverOk = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version.trim());
  return (
    <Drawer
      title="Versiyon oluştur"
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            Vazgeç
          </button>
          <button className="btn pri" disabled={!build || !semverOk || create.isPending} onClick={() => create.mutate()}>
            {create.isPending && <span className="spinner" />} Oluştur
          </button>
        </>
      }
    >
      {builds.isLoading ? (
        <span className="spinner" />
      ) : !passed.length ? (
        <Empty title="Başarılı build yok">Önce bir build çalıştırın.</Empty>
      ) : (
        <>
          <Field label="Build" id="v-build">
            <select id="v-build" className="in" value={build?.id ?? ''} onChange={(e) => setBuildId(e.target.value)}>
              {passed.map((b) => (
                <option key={b.id} value={b.id}>
                  #{b.number} · {b.branch} · {shortSha(b.commitSha)} {b.commitMessage.slice(0, 60)}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Versiyon" id="v-ver" hint={latest ? `Son versiyon v${latest.version}` : 'Semver: MAJOR.MINOR.PATCH'} error={version && !semverOk ? 'Semver biçiminde olmalı (ör. 2.8.4)' : null}>
            <input id="v-ver" className="in mono" value={version} onChange={(e) => setVersion(e.target.value)} />
          </Field>
          <Field label="Sürüm notları" id="v-notes" hint={latest ? `v${latest.version} sonrasındaki commit'lerden taslak oluşturuldu` : undefined}>
            <textarea
              id="v-notes"
              className="in"
              style={{ minHeight: 180 }}
              value={notes}
              onChange={(e) => {
                setTouched(true);
                setNotes(e.target.value);
              }}
              maxLength={20000}
            />
          </Field>
          <p className="small muted">Migration dosyaları önceki versiyonla karşılaştırılarak otomatik tespit edilir ve risk seviyesi gösterilir.</p>
          {create.error && <div className="badbox">{errorMessage(create.error)}</div>}
        </>
      )}
    </Drawer>
  );
}
