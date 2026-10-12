'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { BookOpen, Download, ExternalLink, Presentation } from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';
import { api, errorMessage } from '@/lib/api';
import { ago, bytes, dateTime, shortSha } from '@/lib/format';
import { useProjectSlug } from '@/lib/hooks';
import { Async, Empty, Field, Panel } from '@/components/ui';
import { useToast } from '@/components/toast';

interface Overview {
  previews: { id: string; slug: string; branch: string; commit: string; createdAt: string }[];
  job: { id: string; status: string; error: string | null; createdAt: string; finishedAt: string | null; result: { pages?: number; ai?: boolean } | null } | null;
  documents: { id: string; fileName: string; sizeBytes: number; createdAt: string; kind: 'guide' | 'slides' }[];
  canGenerate: boolean;
}

/** User guide and presentation for the people who will use the application (not developers). */
export default function GuidePage() {
  const slug = useProjectSlug();
  const qc = useQueryClient();
  const toast = useToast();
  const q = useQuery({
    queryKey: ['guide', slug],
    queryFn: () => api<Overview>(`/projects/${slug}/guide`),
    refetchInterval: (query) => (query.state.data?.job && ['queued', 'running'].includes(query.state.data.job.status) ? 3000 : false),
  });
  const [previewId, setPreviewId] = useState('');
  const generate = useMutation({
    mutationFn: (id: string) => api(`/projects/${slug}/guide`, { method: 'POST', body: { previewId: id } }),
    onSuccess: () => {
      toast('Hazırlanıyor — sayfalar geziliyor ve ekran görüntüleri alınıyor');
      void qc.invalidateQueries({ queryKey: ['guide', slug] });
    },
    onError: (e) => toast(errorMessage(e), 'bad'),
  });
  return (
    <>
      <div style={{ marginBottom: 18 }}>
        <h2 style={{ margin: 0 }}>Sunum ve kullanım kılavuzu</h2>
        <p className="sub">Uygulamayı kullanacak kişilere verilecek iki PDF: adım adım anlatan bir kılavuz ve tanıtım sunumu. Sayfalar çalışan ön izlemeden gezilip ekran görüntüleriyle, teknik olmayan bir dille anlatılır.</p>
      </div>
      <Async q={q} rows={3}>
        {(d) => {
          const running = d.job && ['queued', 'running'].includes(d.job.status);
          const selected = previewId || d.previews[0]?.id || '';
          const latest = (kind: 'guide' | 'slides') => d.documents.find((x) => x.kind === kind);
          return (
            <div style={{ display: 'grid', gap: 20 }}>
              <Panel title="Yeni sürüm hazırla">
                {d.previews.length ? (
                  <div className="row" style={{ gap: 12, alignItems: 'flex-end', flexWrap: 'wrap' }}>
                    <Field label="Kaynak ön izleme" id="g-preview" hint="Kılavuz bu ön izlemedeki sayfalardan hazırlanır">
                      <select id="g-preview" className="in" style={{ minWidth: 320 }} value={selected} onChange={(e) => setPreviewId(e.target.value)} disabled={!d.canGenerate || !!running}>
                        {d.previews.map((p) => (
                          <option key={p.id} value={p.id}>
                            {p.branch} · {shortSha(p.commit)} · {ago(p.createdAt)}
                          </option>
                        ))}
                      </select>
                    </Field>
                    <button className="btn pri" style={{ marginBottom: 12 }} disabled={!d.canGenerate || !!running || generate.isPending || !selected} onClick={() => generate.mutate(selected)}>
                      {running ? <span className="spinner" /> : <BookOpen size={16} />} {running ? 'Hazırlanıyor…' : 'Kılavuz ve sunumu hazırla'}
                    </button>
                  </div>
                ) : (
                  <Empty title="Çalışan ön izleme yok" action={<Link className="btn pri" href={`/projects/${slug}/previews`}>Ön izleme başlat</Link>}>
                    Kılavuz, uygulamanın çalışan hâlinden hazırlanır. Önce bir ön izleme başlatın.
                  </Empty>
                )}
                {d.job?.status === 'failed' && <div className="badbox small">Son deneme başarısız: {d.job.error}</div>}
                {d.job?.status === 'completed' && d.job.result && (
                  <p className="small muted" style={{ margin: 0 }}>
                    Son hazırlık {ago(d.job.finishedAt ?? d.job.createdAt)}: {d.job.result.pages} sayfa, {d.job.result.ai ? 'metinler yapay zekâ ile sadeleştirildi' : 'metinler sayfa yapısından otomatik yazıldı'}.
                  </p>
                )}
              </Panel>
              <div className="grid g2">
                {(['guide', 'slides'] as const).map((kind) => {
                  const doc = latest(kind);
                  return (
                    <Panel key={kind} title={kind === 'guide' ? 'Kullanım kılavuzu (A4)' : 'Tanıtım sunumu (16:9)'}>
                      <div className="row" style={{ gap: 14, alignItems: 'flex-start' }}>
                        <span className="int-icon" style={{ width: 48, height: 48 }}>
                          {kind === 'guide' ? <BookOpen size={22} /> : <Presentation size={22} />}
                        </span>
                        <div style={{ flex: 1, minWidth: 0 }}>
                          {doc ? (
                            <>
                              <b className="ellipsis" style={{ display: 'block' }}>
                                {doc.fileName}
                              </b>
                              <div className="small muted">
                                {dateTime(doc.createdAt)} · {bytes(doc.sizeBytes)}
                              </div>
                              <div className="row" style={{ gap: 8, marginTop: 12 }}>
                                <a className="btn sm pri" href={`/api/v1/artifacts/${doc.id}/content`} target="_blank" rel="noreferrer">
                                  <ExternalLink size={14} /> Aç
                                </a>
                                <a className="btn sm" href={`/api/v1/artifacts/${doc.id}/content`} download={doc.fileName}>
                                  <Download size={14} /> İndir
                                </a>
                              </div>
                            </>
                          ) : (
                            <p className="small muted" style={{ margin: 0 }}>
                              {kind === 'guide' ? 'Her sayfa için ekran görüntüsü, ne işe yaradığı ve adım adım kullanımı.' : 'Toplantıda gösterilecek kısa tanıtım: sayfalar, öne çıkanlar ve telefon görünümü.'} Henüz hazırlanmadı.
                            </p>
                          )}
                        </div>
                      </div>
                    </Panel>
                  );
                })}
              </div>
              {d.documents.length > 2 && (
                <Panel title="Önceki sürümler" flush>
                  {d.documents.slice(2).map((doc) => (
                    <a key={doc.id} className="list-item" href={`/api/v1/artifacts/${doc.id}/content`} target="_blank" rel="noreferrer">
                      {doc.kind === 'guide' ? <BookOpen size={16} /> : <Presentation size={16} />}
                      <span style={{ flex: 1 }}>{doc.fileName}</span>
                      <span className="small muted">{dateTime(doc.createdAt)}</span>
                    </a>
                  ))}
                </Panel>
              )}
            </div>
          );
        }}
      </Async>
    </>
  );
}
