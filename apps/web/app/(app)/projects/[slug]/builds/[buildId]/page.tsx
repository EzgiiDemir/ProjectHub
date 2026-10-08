'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Bot, ExternalLink, RotateCcw, Square } from 'lucide-react';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import type { Permission } from '@projecthub/contracts';
import { api, errorMessage } from '@/lib/api';
import { ago, bytes, dateTime, duration, shortSha } from '@/lib/format';
import { useProject, useProjectSlug } from '@/lib/hooks';
import type { Build, BuildDetail, Preview } from '@/lib/types';
import { ErrorState, KeyValue, Loading, LogView, Markdown, Panel, Pipeline, StatusBadge } from '@/components/ui';
import { useToast } from '@/components/toast';

/** Live build view: the API streams step changes and log text over SSE until the build ends (spec §69). */
export default function BuildDetailPage() {
  const { buildId } = useParams<{ buildId: string }>();
  const slug = useProjectSlug();
  const router = useRouter();
  const toast = useToast();
  const qc = useQueryClient();
  const project = useProject().data;
  const [build, setBuild] = useState<BuildDetail | null>(null);
  const [log, setLog] = useState('');
  const [error, setError] = useState<unknown>(null);
  const [follow, setFollow] = useState(true);
  const [epoch, setEpoch] = useState(0);
  const logRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setLog('');
    setError(null);
    const es = new EventSource(`/api/v1/builds/${buildId}/events`);
    es.addEventListener('build', (m) => setBuild(JSON.parse((m as MessageEvent).data) as BuildDetail));
    es.addEventListener('log', (m) => setLog((l) => l + (JSON.parse((m as MessageEvent).data) as { text: string }).text));
    es.addEventListener('end', () => es.close());
    es.onerror = () => {
      // Closed by the server after "end", or the build is not accessible: fall back to a plain fetch.
      es.close();
      api<BuildDetail>(`/builds/${buildId}`)
        .then((b) => {
          setBuild(b);
          return api<{ text: string }>(`/builds/${buildId}/log`);
        })
        .then((r) => setLog((l) => (l.length >= r.text.length ? l : r.text)))
        .catch(setError);
    };
    return () => es.close();
  }, [buildId, epoch]);

  useEffect(() => {
    const el = logRef.current?.querySelector('pre');
    if (follow && el) el.scrollTop = el.scrollHeight;
  }, [log, follow]);

  const cancel = useMutation({ mutationFn: () => api(`/builds/${buildId}/cancel`, { method: 'POST' }), onSuccess: () => toast('Build iptal ediliyor'), onError: (e) => toast(errorMessage(e), 'bad') });
  const retry = useMutation({
    mutationFn: () => api<Build>(`/builds/${buildId}/retry`, { method: 'POST' }),
    onSuccess: (b) => router.push(`/projects/${slug}/builds/${b.id}`),
    onError: (e) => toast(errorMessage(e), 'bad'),
  });
  const analyze = useMutation({
    mutationFn: () => api(`/builds/${buildId}/analyze`, { method: 'POST' }),
    onSuccess: () => {
      toast('AI analizi kuyruğa alındı; sonuç birkaç saniye içinde burada görünecek');
      setTimeout(() => setEpoch((e) => e + 1), 8000);
    },
    onError: (e) => toast(errorMessage(e), 'bad'),
  });
  const preview = useMutation({
    mutationFn: () => api<Preview>(`/projects/${slug}/previews`, { method: 'POST', body: { buildId } }),
    onSuccess: () => {
      toast('Ön izleme başlatılıyor');
      void qc.invalidateQueries({ queryKey: ['previews'] });
      setEpoch((e) => e + 1);
    },
    onError: (e) => toast(errorMessage(e), 'bad'),
  });
  const aiFix = useMutation({
    mutationFn: () => api<{ id: string }>(`/projects/${slug}/ai/tasks`, { method: 'POST', body: { sourceType: 'build', sourceId: buildId } }),
    onSuccess: (t) => router.push(`/projects/${slug}/ai/tasks/${t.id}`),
    onError: (e) => toast(errorMessage(e), 'bad'),
  });

  if (error && !build) return <ErrorState error={error} onRetry={() => setEpoch((e) => e + 1)} />;
  if (!build) return <Loading label="Build yükleniyor…" />;
  const can = (p: Permission) => !!project?.permissions.includes(p);
  const active = build.status === 'queued' || build.status === 'running';
  const livePreview = build.previews.find((p) => p.status === 'ready' || p.status === 'starting');

  return (
    <>
      <div className="spread" style={{ marginBottom: 12 }}>
        <div>
          <div className="small muted">
            <Link href={`/projects/${slug}/builds`}>Build&apos;ler</Link> /
          </div>
          <h2 style={{ margin: '2px 0 0' }} className="row">
            Build #{build.number} <StatusBadge status={build.status} />
          </h2>
          <p className="sub" style={{ margin: '4px 0 0' }}>
            <span className="tag">{build.branch}</span> <span className="mono">{shortSha(build.commitSha)}</span> {build.commitMessage}
          </p>
        </div>
        <div className="row">
          {active && can('build.create') && (
            <button className="btn" onClick={() => cancel.mutate()} disabled={cancel.isPending}>
              <Square /> İptal et
            </button>
          )}
          {!active && can('build.create') && (
            <button className="btn" onClick={() => retry.mutate()} disabled={retry.isPending}>
              <RotateCcw /> Tekrar çalıştır
            </button>
          )}
          {build.status === 'passed' && !livePreview && can('preview.create') && (
            <button className="btn pri" onClick={() => preview.mutate()} disabled={preview.isPending}>
              Ön izleme oluştur
            </button>
          )}
          {livePreview && (
            <Link className="btn pri" href={`/projects/${slug}/previews?open=${livePreview.id}`}>
              <ExternalLink /> Ön izlemeyi aç
            </Link>
          )}
        </div>
      </div>

      {build.error && (
        <div className="badbox" style={{ marginBottom: 14 }}>
          <b>{build.error.step} adımında hata.</b> {build.error.message}
          {build.error.file && (
            <div className="mono small" style={{ marginTop: 4 }}>
              <Link href={`/projects/${slug}/code?path=${encodeURIComponent(build.error.file)}&ref=${build.commitSha}${build.error.line ? `&line=${build.error.line}` : ''}`}>
                {build.error.file}
                {build.error.line ? `:${build.error.line}` : ''}
              </Link>
            </div>
          )}
        </div>
      )}

      <div className="grid" style={{ gridTemplateColumns: 'minmax(0, 1fr) 320px', alignItems: 'start' }}>
        <div className="grid" style={{ gap: 14 }}>
          {build.status === 'failed' && (
            <Panel
              title={
                <span className="row" style={{ gap: 6 }}>
                  <Bot size={16} /> AI hata analizi
                </span>
              }
              actions={
                can('ai.execute') && (
                  <>
                    <button className="btn sm" onClick={() => analyze.mutate()} disabled={analyze.isPending}>
                      {build.aiAnalysis ? 'Yeniden analiz et' : 'Analiz et'}
                    </button>
                    <button className="btn sm pri" onClick={() => aiFix.mutate()} disabled={aiFix.isPending}>
                      AI düzeltme önersin
                    </button>
                  </>
                )
              }
            >
              {build.aiAnalysis ? (
                <div className="ai-note">
                  <Markdown text={build.aiAnalysis} className="prose small" />
                </div>
              ) : (
                <p className="muted small" style={{ margin: 0 }}>
                  Analiz henüz yok. AI, logu ve ilgili dosyaları inceleyip olası nedeni ve çözümü açıklar; kodu değiştirmez. Düzeltme önerisi ayrı bir AI branch&apos;inde hazırlanır ve onayınızı bekler.
                </p>
              )}
            </Panel>
          )}
          <Panel
            title="Log"
            actions={
              <label className="check small">
                <input type="checkbox" checked={follow} onChange={(e) => setFollow(e.target.checked)} /> Sona kaydır
              </label>
            }
          >
            <div ref={logRef}>{log ? <LogView text={log} /> : <p className="muted small">{active ? 'Log bekleniyor…' : 'Bu build için log kaydı yok (saklama süresi dolmuş olabilir).'}</p>}</div>
          </Panel>
        </div>
        <div className="grid" style={{ gap: 14 }}>
          <Panel title="Adımlar">
            {build.steps.length ? <Pipeline steps={build.steps} /> : <p className="muted small">Build sırada; adımlar başladığında görünür.</p>}
          </Panel>
          <Panel title="Ayrıntılar">
            <KeyValue
              items={[
                ['Tetikleyen', build.triggeredByName ?? '—'],
                ['Kuyruğa alındı', dateTime(build.createdAt)],
                ['Başladı', dateTime(build.startedAt)],
                ['Süre', duration(build.durationMs)],
                ['Çıktı', build.outputKind === 'process' ? 'Uygulama sunucusu' : build.outputKind === 'static' ? 'Statik site' : '—'],
                ['Komutlar', build.manifest ? <span className="mono small">{[build.manifest.install?.command, build.manifest.build?.command, build.manifest.test?.command].filter(Boolean).join(' → ') || '—'}</span> : '—'],
                [
                  'Artifact',
                  build.artifact ? (
                    <span>
                      {bytes(build.artifact.sizeBytes)} {!build.artifact.available && <span className="muted">(silinmiş)</span>}
                      {build.artifact.retentionUntil && <div className="small muted">saklama: {ago(build.artifact.retentionUntil)}</div>}
                    </span>
                  ) : (
                    '—'
                  ),
                ],
              ]}
            />
          </Panel>
          {build.previews.length > 0 && (
            <Panel title="Ön izlemeler" flush>
              {build.previews.map((p) => (
                <Link key={p.id} className="list-item" href={`/projects/${slug}/previews?open=${p.id}`}>
                  <span className="mono small" style={{ flex: 1 }}>
                    {p.slug}
                  </span>
                  <StatusBadge status={p.status} />
                </Link>
              ))}
            </Panel>
          )}
        </div>
      </div>
    </>
  );
}
