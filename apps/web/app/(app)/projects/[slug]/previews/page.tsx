'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ExternalLink, MonitorSmartphone, Plus } from 'lucide-react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useState } from 'react';
import { api, apiPaged, errorMessage } from '@/lib/api';
import { ago, dateTime, shortSha, until } from '@/lib/format';
import { useProject, useProjectSlug } from '@/lib/hooks';
import { openPreview } from '@/lib/preview';
import type { Build, Preview } from '@/lib/types';
import { Async, Drawer, Empty, Field, KeyValue, LogView, Modal, Panel, StatusBadge } from '@/components/ui';
import { useToast } from '@/components/toast';

export default function PreviewsPage() {
  const slug = useProjectSlug();
  const params = useSearchParams();
  const router = useRouter();
  const toast = useToast();
  const project = useProject().data;
  const [creating, setCreating] = useState(false);
  const q = useQuery({ queryKey: ['previews', slug], queryFn: () => api<Preview[]>(`/projects/${slug}/previews`), refetchInterval: (query) => ((query.state.data ?? []).some((p) => p.status === 'starting' || p.status === 'queued') ? 3000 : false) });
  const openId = params.get('open');
  const selected = q.data?.find((p) => p.id === openId);
  const canCreate = !!project?.permissions.includes('preview.create') && project.status !== 'archived';

  return (
    <>
      <div className="spread" style={{ marginBottom: 12 }}>
        <div>
          <h2 style={{ margin: 0 }}>Ön izlemeler</h2>
          <p className="sub">Başarılı build&apos;lerden oluşturulan, süreli ve izole çalışan sürümler. Kullanıcı linkleri bu ön izlemeleri kullanır.</p>
        </div>
        {canCreate && (
          <button className="btn pri" onClick={() => setCreating(true)}>
            <Plus /> Ön izleme oluştur
          </button>
        )}
      </div>
      <Async q={q} rows={4}>
        {(rows) =>
          rows.length ? (
            <Panel flush>
              <div className="tbl">
                <table>
                  <thead>
                    <tr>
                      <th>Ön izleme</th>
                      <th>Durum</th>
                      <th>Kaynak</th>
                      <th>Tür</th>
                      <th>Süre</th>
                      <th />
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((p) => (
                      <tr key={p.id} className="click" onClick={() => router.replace(`/projects/${slug}/previews?open=${p.id}`)}>
                        <td>
                          <div className="mono small">{p.slug}</div>
                          <div className="small muted">
                            Build #{p.buildNumber} · {p.createdByName ?? 'sistem'} · {ago(p.createdAt)}
                          </div>
                        </td>
                        <td>
                          <StatusBadge status={p.status} />
                        </td>
                        <td className="small">
                          <span className="tag">{p.sourceBranch}</span> <span className="mono">{shortSha(p.sourceCommit)}</span>
                        </td>
                        <td className="small">{p.kind === 'process' ? 'Uygulama' : 'Statik'}</td>
                        <td className="small muted">{p.status === 'ready' || p.status === 'starting' ? until(p.expiresAt) : '—'}</td>
                        <td onClick={(e) => e.stopPropagation()} style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                          {p.status === 'ready' && (
                            <>
                              <Link className="btn sm" href={`/projects/${slug}/simulator?preview=${p.id}`} title="Cihaz simülatöründe aç">
                                <MonitorSmartphone />
                              </Link>{' '}
                              <button className="btn sm" onClick={() => openPreview(p.id).catch((e) => toast(errorMessage(e), 'bad'))}>
                                <ExternalLink /> Aç
                              </button>
                            </>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Panel>
          ) : (
            <Empty title="Ön izleme yok" action={canCreate && <button className="btn pri" onClick={() => setCreating(true)}>Başarılı bir build&apos;den oluştur</button>}>
              Ön izleme, başarılı bir build&apos;in çıktısını izole bir adreste çalıştırır.
            </Empty>
          )
        }
      </Async>
      {selected && <PreviewDrawer preview={selected} slug={slug} canManage={canCreate} onClose={() => router.replace(`/projects/${slug}/previews`)} />}
      {creating && <CreatePreview slug={slug} onClose={() => setCreating(false)} />}
    </>
  );
}

function PreviewDrawer({ preview: p, slug, canManage, onClose }: { preview: Preview; slug: string; canManage: boolean; onClose: () => void }) {
  const toast = useToast();
  const qc = useQueryClient();
  const live = p.status === 'ready' || p.status === 'starting';
  const logs = useQuery({ queryKey: ['previewLogs', p.id], queryFn: () => api<{ text: string }>(`/previews/${p.id}/logs`), enabled: p.kind === 'process', refetchInterval: live ? 5000 : false });
  const done = () => void qc.invalidateQueries({ queryKey: ['previews'] });
  const stop = useMutation({ mutationFn: () => api(`/previews/${p.id}/stop`, { method: 'POST' }), onSuccess: () => (toast('Ön izleme durduruldu'), done()), onError: (e) => toast(errorMessage(e), 'bad') });
  const extend = useMutation({
    mutationFn: (hours: number) => api<{ expiresAt: string }>(`/previews/${p.id}/extend`, { method: 'POST', body: { hours } }),
    onSuccess: (r) => (toast(`Süre uzatıldı: ${dateTime(r.expiresAt)}`), done()),
    onError: (e) => toast(errorMessage(e), 'bad'),
  });
  return (
    <Drawer
      title={<span className="mono">{p.slug}</span>}
      onClose={onClose}
      wide={p.kind === 'process'}
      footer={
        live && canManage ? (
          <>
            <button className="btn danger" onClick={() => stop.mutate()} disabled={stop.isPending}>
              Durdur
            </button>
            <button className="btn" onClick={() => extend.mutate(24)} disabled={extend.isPending}>
              +24 saat
            </button>
            <button className="btn" onClick={() => extend.mutate(24 * 7)} disabled={extend.isPending}>
              +7 gün
            </button>
            {p.status === 'ready' && (
              <button className="btn pri" onClick={() => openPreview(p.id).catch((e) => toast(errorMessage(e), 'bad'))}>
                <ExternalLink /> Aç
              </button>
            )}
          </>
        ) : undefined
      }
    >
      {p.error && <div className="badbox" style={{ marginBottom: 12 }}>{p.error}</div>}
      <KeyValue
        items={[
          ['Durum', <StatusBadge key="s" status={p.status} />],
          ['Adres', <span key="u" className="mono small">{p.url}</span>],
          ['Build', <Link key="b" href={`/projects/${slug}/builds/${p.buildId}`}>#{p.buildNumber}</Link>],
          ['Kaynak', `${p.sourceBranch} · ${shortSha(p.sourceCommit)}`],
          ['Tür', p.kind === 'process' ? 'Uygulama sunucusu (izole süreç)' : 'Statik dosyalar'],
          ['Oluşturan', p.createdByName ?? 'sistem'],
          ['Oluşturulma', dateTime(p.createdAt)],
          ['Bitiş', live ? `${dateTime(p.expiresAt)} (${until(p.expiresAt)})` : dateTime(p.stoppedAt ?? p.expiresAt)],
        ]}
      />
      <div className="row" style={{ marginTop: 14 }}>
        {p.status === 'ready' && (
          <Link className="btn" href={`/projects/${slug}/simulator?preview=${p.id}`}>
            <MonitorSmartphone /> Simülatörde aç
          </Link>
        )}
        {p.status === 'ready' && (
          <Link className="btn" href={`/projects/${slug}/reviews?new=1&preview=${p.id}`}>
            Kullanıcıya gönder
          </Link>
        )}
      </div>
      {p.kind === 'process' && (
        <>
          <h3 style={{ margin: '18px 0 8px' }}>Uygulama çıktısı</h3>
          {logs.data?.text ? <LogView text={logs.data.text} maxHeight={420} /> : <p className="muted small">Çıktı yok.</p>}
        </>
      )}
    </Drawer>
  );
}

function CreatePreview({ slug, onClose }: { slug: string; onClose: () => void }) {
  const toast = useToast();
  const qc = useQueryClient();
  const builds = useQuery({ queryKey: ['builds', slug, 'passed'], queryFn: () => apiPaged<Build>(`/projects/${slug}/builds?limit=50`) });
  const passed = (builds.data?.data ?? []).filter((b) => b.status === 'passed');
  const [buildId, setBuildId] = useState('');
  const [ttl, setTtl] = useState('');
  const create = useMutation({
    mutationFn: () => api<Preview>(`/projects/${slug}/previews`, { method: 'POST', body: { buildId: buildId || passed[0]?.id, ...(ttl ? { ttlMinutes: Number(ttl) } : {}) } }),
    onSuccess: () => {
      toast('Ön izleme başlatılıyor');
      void qc.invalidateQueries({ queryKey: ['previews'] });
      onClose();
    },
  });
  return (
    <Modal
      title="Ön izleme oluştur"
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            Vazgeç
          </button>
          <button className="btn pri" disabled={!passed.length || create.isPending} onClick={() => create.mutate()}>
            {create.isPending && <span className="spinner" />} Oluştur
          </button>
        </>
      }
    >
      {builds.isLoading ? (
        <span className="spinner" />
      ) : passed.length ? (
        <>
          <Field label="Build" id="pv-build">
            <select id="pv-build" className="in" value={buildId || passed[0]!.id} onChange={(e) => setBuildId(e.target.value)}>
              {passed.map((b) => (
                <option key={b.id} value={b.id}>
                  #{b.number} · {b.branch} · {shortSha(b.commitSha)} {b.commitMessage.slice(0, 60)}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Süre" id="pv-ttl" hint="Boş bırakılırsa projecthub.yml içindeki preview.ttl kullanılır.">
            <select id="pv-ttl" className="in" value={ttl} onChange={(e) => setTtl(e.target.value)}>
              <option value="">Manifest varsayılanı</option>
              <option value="120">2 saat</option>
              <option value="1440">24 saat</option>
              <option value="4320">3 gün</option>
              <option value="10080">7 gün</option>
            </select>
          </Field>
        </>
      ) : (
        <p className="muted">Başarılı build yok. Önce bir build çalıştırın.</p>
      )}
      {create.error && <div className="badbox">{errorMessage(create.error)}</div>}
    </Modal>
  );
}
