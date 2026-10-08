'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus, Send } from 'lucide-react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import type { ReviewCapabilities } from '@projecthub/contracts';
import { api, errorMessage } from '@/lib/api';
import { ago, dateTime, time, until } from '@/lib/format';
import { useProject, useProjectSlug } from '@/lib/hooks';
import type { Feedback, Preview, Review } from '@/lib/types';
import { Async, ConfirmDialog, CopyButton, Drawer, Empty, Field, KeyValue, Panel, StatusBadge, Tabs } from '@/components/ui';
import { useToast } from '@/components/toast';

const CAPS: [keyof ReviewCapabilities, string, string][] = [
  ['feedback', 'Geri bildirim', 'Sayfada nokta seçip yorum, hata veya değişiklik talebi bırakabilir'],
  ['screenshots', 'Ekran görüntüsü', 'Geri bildirimle birlikte o anki ekranın görüntüsü otomatik alınır'],
  ['deviceSwitch', 'Cihaz değiştirme', 'Telefon, tablet ve masaüstü boyutlarında görüntüleyebilir'],
  ['chat', 'Ekiple yazışma', 'Proje ekibine mesaj gönderebilir'],
  ['docs', 'Dokümanlar', 'Sürüm notlarını ve README dosyasını görebilir'],
];

/** Customer review links (spec §54–60): time-limited, revocable access to a preview, without an account. */
export default function ReviewsPage() {
  const slug = useProjectSlug();
  const params = useSearchParams();
  const router = useRouter();
  const project = useProject().data;
  const q = useQuery({ queryKey: ['reviews', slug], queryFn: () => api<Review[]>(`/projects/${slug}/reviews`) });
  const canCreate = !!project?.permissions.includes('review.create') && project.status !== 'archived';
  const creating = params.get('new') === '1';
  const openId = params.get('open');
  const base = `/projects/${slug}/reviews`;

  return (
    <>
      <div className="spread" style={{ marginBottom: 12 }}>
        <div>
          <h2 style={{ margin: 0 }}>Müşteri linkleri</h2>
          <p className="sub">Müşteri hesap açmadan ön izlemeyi görür, sayfa üzerinde geri bildirim bırakır. Linkler süreli ve her an kapatılabilir.</p>
        </div>
        {canCreate && (
          <button className="btn pri" onClick={() => router.replace(`${base}?new=1`)}>
            <Plus /> Yeni müşteri linki
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
                      <th>Link</th>
                      <th>Durum</th>
                      <th>Ziyaretçi</th>
                      <th>Geri bildirim</th>
                      <th>Son erişim</th>
                      <th>Geçerlilik</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((r) => (
                      <tr key={r.id} className="click" onClick={() => router.replace(`${base}?open=${r.id}`)}>
                        <td>
                          <b>{r.name}</b> <span className="mono small muted">{r.key}</span>
                          <div className="small muted">
                            {r.versionLabel} {r.passwordProtected && '· şifreli'}
                          </div>
                        </td>
                        <td>
                          <StatusBadge status={r.status} />
                        </td>
                        <td>{r.visitorCount ?? 0}</td>
                        <td>{r.feedbackCount ?? 0}</td>
                        <td className="small muted">{r.lastAccessAt ? ago(r.lastAccessAt) : 'henüz açılmadı'}</td>
                        <td className="small muted">{r.status === 'active' ? until(r.expiresAt) : dateTime(r.revokedAt ?? r.expiresAt)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Panel>
          ) : (
            <Empty title="Müşteri linki yok" action={canCreate && <button className="btn pri" onClick={() => router.replace(`${base}?new=1`)}>İlk linki oluştur</button>}>
              Çalışan bir ön izlemeyi müşteriyle paylaşmak için link oluşturun.
            </Empty>
          )
        }
      </Async>
      {creating && canCreate && <CreateReview slug={slug} initialPreview={params.get('preview')} onClose={() => router.replace(base)} onCreated={(id) => router.replace(`${base}?open=${id}`)} />}
      {openId && <ReviewDrawer id={openId} slug={slug} onClose={() => router.replace(base)} />}
    </>
  );
}

function CreateReview({ slug, initialPreview, onClose, onCreated }: { slug: string; initialPreview: string | null; onClose: () => void; onCreated: (id: string) => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const project = useProject().data;
  const previews = useQuery({ queryKey: ['previews', slug], queryFn: () => api<Preview[]>(`/projects/${slug}/previews`) });
  const ready = (previews.data ?? []).filter((p) => p.status === 'ready');
  const [previewId, setPreviewId] = useState(initialPreview ?? '');
  const [name, setName] = useState(project ? `${project.name} müşteri incelemesi` : '');
  const [expiry, setExpiry] = useState('10080');
  const [password, setPassword] = useState('');
  const [caps, setCaps] = useState<ReviewCapabilities>({ feedback: true, screenshots: true, deviceSwitch: true, chat: true, docs: true });
  const selected = previewId || ready[0]?.id || '';
  const create = useMutation({
    mutationFn: () => api<Review>(`/projects/${slug}/reviews`, { method: 'POST', body: { previewId: selected, name, expiresInMinutes: Number(expiry), password: password || undefined, capabilities: caps } }),
    onSuccess: (r) => {
      toast('Müşteri linki oluşturuldu');
      void qc.invalidateQueries({ queryKey: ['reviews'] });
      onCreated(r.id);
    },
  });
  const pv = ready.find((p) => p.id === selected);
  const reviewMinutes = Number(expiry);
  const outlives = pv && new Date(pv.expiresAt).getTime() < Date.now() + reviewMinutes * 60_000;
  return (
    <Drawer
      title="Yeni müşteri linki"
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            Vazgeç
          </button>
          <button className="btn pri" disabled={!selected || !name.trim() || create.isPending || (!!password && password.length < 6)} onClick={() => create.mutate()}>
            {create.isPending && <span className="spinner" />} Linki oluştur
          </button>
        </>
      }
    >
      {previews.isLoading ? (
        <span className="spinner" />
      ) : !ready.length ? (
        <Empty title="Çalışan ön izleme yok" action={<Link className="btn" href={`/projects/${slug}/previews`}>Ön izleme oluştur</Link>}>
          Müşteri linki çalışan bir ön izlemeye bağlanır.
        </Empty>
      ) : (
        <>
          <Field label="Ön izleme" id="rv-pv">
            <select id="rv-pv" className="in" value={selected} onChange={(e) => setPreviewId(e.target.value)}>
              {ready.map((p) => (
                <option key={p.id} value={p.id}>
                  Build #{p.buildNumber} · {p.sourceBranch} · {p.slug}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Link adı" id="rv-name" hint="Müşterinin göreceği başlık">
            <input id="rv-name" className="in" value={name} onChange={(e) => setName(e.target.value)} maxLength={150} />
          </Field>
          <Field label="Geçerlilik" id="rv-exp">
            <select id="rv-exp" className="in" value={expiry} onChange={(e) => setExpiry(e.target.value)}>
              <option value="1440">1 gün</option>
              <option value="4320">3 gün</option>
              <option value="10080">7 gün</option>
              <option value="20160">14 gün</option>
              <option value="43200">30 gün</option>
            </select>
          </Field>
          {outlives && <div className="warnbox" style={{ marginTop: -4, marginBottom: 12 }}>Ön izlemenin süresi linkten önce doluyor; ön izleme, link geçerli olduğu sürece otomatik uzatılır.</div>}
          <Field label="Şifre (isteğe bağlı)" id="rv-pw" hint="En az 6 karakter. Müşteriye ayrı bir kanaldan iletin." error={password && password.length < 6 ? 'En az 6 karakter' : null}>
            <input id="rv-pw" className="in" type="text" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="off" />
          </Field>
          <div className="field">
            <label>Müşteri neler yapabilir?</label>
            {CAPS.map(([k, label, hint]) => (
              <label key={k} className="check" style={{ alignItems: 'flex-start' }}>
                <input type="checkbox" checked={caps[k]} onChange={(e) => setCaps((c) => ({ ...c, [k]: e.target.checked }))} disabled={k === 'screenshots' && !caps.feedback} />
                <span>
                  {label}
                  <div className="small muted">{hint}</div>
                </span>
              </label>
            ))}
          </div>
          {create.error && <div className="badbox">{errorMessage(create.error)}</div>}
        </>
      )}
    </Drawer>
  );
}

function ReviewDrawer({ id, slug, onClose }: { id: string; slug: string; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [tab, setTab] = useState<'info' | 'chat' | 'feedback'>('info');
  const [revoking, setRevoking] = useState(false);
  const q = useQuery({ queryKey: ['review', id], queryFn: () => api<Review>(`/reviews/${id}`) });
  const previews = useQuery({ queryKey: ['previews', slug], queryFn: () => api<Preview[]>(`/projects/${slug}/previews`) });
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['review', id] });
    void qc.invalidateQueries({ queryKey: ['reviews'] });
  };
  const revoke = useMutation({ mutationFn: () => api(`/reviews/${id}/revoke`, { method: 'POST' }), onSuccess: () => (toast('Link kapatıldı'), setRevoking(false), refresh()), onError: (e) => toast(errorMessage(e), 'bad') });
  const extend = useMutation({ mutationFn: (hours: number) => api(`/reviews/${id}/extend`, { method: 'POST', body: { hours } }), onSuccess: () => (toast('Süre uzatıldı'), refresh()), onError: (e) => toast(errorMessage(e), 'bad') });
  const switchPv = useMutation({ mutationFn: (previewId: string) => api(`/reviews/${id}/switch-preview`, { method: 'POST', body: { previewId } }), onSuccess: () => (toast('Link yeni ön izlemeye bağlandı'), refresh()), onError: (e) => toast(errorMessage(e), 'bad') });

  return (
    <Drawer title={q.data ? `${q.data.key} · ${q.data.name}` : 'Müşteri linki'} onClose={onClose} wide>
      <Async q={q}>
        {(r) => {
          const active = r.status === 'active';
          const others = (previews.data ?? []).filter((p) => p.status === 'ready' && p.id !== r.previewId);
          return (
            <>
              {r.url && active && (
                <div className="okbox" style={{ marginBottom: 14 }}>
                  <div className="small" style={{ marginBottom: 6 }}>
                    Bu linki müşteriye gönderin{r.passwordProtected ? ' (şifreyi ayrı bir kanaldan iletin)' : ''}:
                  </div>
                  <div className="row" style={{ flexWrap: 'nowrap' }}>
                    <code className="small ellipsis" style={{ flex: 1 }}>
                      {r.url}
                    </code>
                    <CopyButton text={r.url} />
                    <a className="btn sm" href={r.url} target="_blank" rel="noreferrer">
                      Aç
                    </a>
                  </div>
                </div>
              )}
              <Tabs
                value={tab}
                onChange={setTab}
                items={[
                  ['info', 'Bilgiler'],
                  ['chat', 'Mesajlar'],
                  ['feedback', `Geri bildirimler (${r.feedbackCount ?? '…'})`],
                ]}
              />
              {tab === 'info' && (
                <>
                  <KeyValue
                    items={[
                      ['Durum', <StatusBadge key="s" status={r.status} />],
                      ['Sürüm', r.versionLabel],
                      ['Ön izleme', r.preview ? <span key="p"><span className="mono small">{r.preview.slug}</span> <StatusBadge status={r.preview.status} /></span> : '—'],
                      ['Geçerlilik', active ? `${dateTime(r.expiresAt)} (${until(r.expiresAt)})` : dateTime(r.revokedAt ?? r.expiresAt)],
                      ['Şifre', r.passwordProtected ? 'var' : 'yok'],
                      ['Yetkiler', CAPS.filter(([k]) => r.capabilities[k]).map(([, l]) => l).join(', ') || '—'],
                      ['Erişim', `${r.accessCount} kez · son ${ago(r.lastAccessAt)}`],
                      ['Oluşturulma', dateTime(r.createdAt)],
                    ]}
                  />
                  <h3 style={{ margin: '18px 0 8px' }}>Ziyaretçiler</h3>
                  {r.visitors?.length ? (
                    <div className="tbl">
                      <table>
                        <tbody>
                          {r.visitors.map((v) => (
                            <tr key={v.id}>
                              <td>
                                <b>
                                  {v.firstName} {v.lastName}
                                </b>{' '}
                                <span className="dept">{v.department}</span>
                                <div className="small muted">{[v.company, v.email].filter(Boolean).join(' · ')}</div>
                              </td>
                              <td className="small muted">{ago(v.lastSeenAt)}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  ) : (
                    <p className="small muted">Henüz kimse linki açmadı.</p>
                  )}
                  {r.url && (
                    <div className="row" style={{ marginTop: 18 }}>
                      {active && others.length > 0 && (
                        <select className="in" style={{ width: 'auto' }} value="" onChange={(e) => e.target.value && switchPv.mutate(e.target.value)} aria-label="Ön izlemeyi değiştir">
                          <option value="">Yeni sürüme bağla…</option>
                          {others.map((p) => (
                            <option key={p.id} value={p.id}>
                              Build #{p.buildNumber} · {p.sourceBranch}
                            </option>
                          ))}
                        </select>
                      )}
                      {r.status !== 'revoked' && (
                        <>
                          <button className="btn" onClick={() => extend.mutate(24 * 3)} disabled={extend.isPending}>
                            +3 gün
                          </button>
                          <button className="btn" onClick={() => extend.mutate(24 * 7)} disabled={extend.isPending}>
                            +7 gün
                          </button>
                        </>
                      )}
                      {active && (
                        <button className="btn danger" onClick={() => setRevoking(true)}>
                          Linki kapat
                        </button>
                      )}
                    </div>
                  )}
                </>
              )}
              {tab === 'chat' && <ReviewChat id={r.id} active={active} />}
              {tab === 'feedback' && <ReviewFeedback slug={slug} reviewId={r.id} />}
              {revoking && (
                <ConfirmDialog
                  title="Müşteri linkini kapat"
                  message="Link hemen geçersiz olur; müşteri ön izlemeyi ve geri bildirim ekranını açamaz. Gelen geri bildirimler korunur."
                  actionLabel="Kapat"
                  busy={revoke.isPending}
                  onConfirm={() => revoke.mutate()}
                  onClose={() => setRevoking(false)}
                />
              )}
            </>
          );
        }}
      </Async>
    </Drawer>
  );
}

type ChatMessage = { id: string; authorType: string; author: string; department: string | null; body: string; createdAt: string };

function ReviewChat({ id, active }: { id: string; active: boolean }) {
  const qc = useQueryClient();
  const [text, setText] = useState('');
  const end = useRef<HTMLDivElement>(null);
  const q = useQuery({ queryKey: ['reviewMessages', id], queryFn: () => api<ChatMessage[]>(`/reviews/${id}/messages`) });
  const send = useMutation({
    mutationFn: () => api<ChatMessage[]>(`/reviews/${id}/messages`, { method: 'POST', body: { body: text } }),
    onSuccess: (msgs) => {
      qc.setQueryData(['reviewMessages', id], msgs);
      setText('');
    },
  });
  useEffect(() => end.current?.scrollIntoView({ block: 'end' }), [q.data]);
  return (
    <div className="panel flush" style={{ display: 'flex', flexDirection: 'column', height: 460 }}>
      <div className="chat">
        {q.data?.length ? (
          q.data.map((m) => (
            <div key={m.id} className={`msg ${m.authorType === 'customer' ? 'ai' : 'me'}`}>
              <div className="small" style={{ opacity: 0.8, marginBottom: 2 }}>
                {m.author}
                {m.department ? ` · ${m.department}` : ''} · {time(m.createdAt)}
              </div>
              {m.body}
            </div>
          ))
        ) : (
          <p className="small muted">Mesaj yok.</p>
        )}
        <div ref={end} />
      </div>
      {active ? (
        <form
          className="chat-in"
          onSubmit={(e) => {
            e.preventDefault();
            if (text.trim()) send.mutate();
          }}
        >
          <input className="in" value={text} onChange={(e) => setText(e.target.value)} placeholder="Müşteriye yanıt yazın…" maxLength={4000} />
          <button className="btn pri" disabled={!text.trim() || send.isPending}>
            <Send />
          </button>
        </form>
      ) : (
        <div className="chat-in small muted">Link aktif değil; mesaj gönderilemez.</div>
      )}
      {send.error && <div className="badbox">{errorMessage(send.error)}</div>}
    </div>
  );
}

function ReviewFeedback({ slug, reviewId }: { slug: string; reviewId: string }) {
  const q = useQuery({ queryKey: ['feedback', slug, 'review', reviewId], queryFn: () => api<Feedback[]>(`/projects/${slug}/feedback?reviewId=${reviewId}`) });
  return (
    <Async q={q}>
      {(rows) =>
        rows.length ? (
          <div className="panel flush">
            {rows.map((f) => (
              <Link key={f.id} className="list-item" href={`/projects/${slug}/feedback/${f.id}`}>
                <span className="mono small muted">{f.key}</span>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div className="ellipsis">{f.title}</div>
                  <div className="small muted">
                    {f.reporter.name} · {ago(f.createdAt)}
                  </div>
                </div>
                <StatusBadge status={f.status} label={f.statusLabel} />
              </Link>
            ))}
          </div>
        ) : (
          <p className="small muted">Bu linkten geri bildirim gelmedi.</p>
        )
      }
    </Async>
  );
}
