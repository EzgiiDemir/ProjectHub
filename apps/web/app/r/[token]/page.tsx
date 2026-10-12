'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { MessageSquarePlus, MousePointerClick, RefreshCw, Send, X } from 'lucide-react';
import { useParams } from 'next/navigation';
import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import type { ReviewCapabilities } from '@projecthub/contracts';
import { api, ApiError, errorMessage } from '@/lib/api';
import { ago, dateTime, time, until } from '@/lib/format';
import { DEPARTMENTS } from '@/lib/labels';
import { DeviceFrame, useBridge, type BridgeMessage, type FrameDevice } from '@/components/device-frame';
import { Field, Loading, Markdown, Segmented, Tabs } from '@/components/ui';
import { useToast } from '@/components/toast';

interface Describe {
  status: 'active' | 'expired' | 'revoked';
  project: { name: string; customerName: string; color: string; short: string };
  branding: { companyLogo: string | null; projectLogo: string | null; customerLogo: string | null; accent: string | null };
  review: { name: string; versionLabel: string; expiresAt: string; capabilities: ReviewCapabilities; passwordRequired: boolean };
  contact: { name: string; email: string } | null;
  visitor: { firstName: string; lastName: string; department: string; company: string; email: string } | null;
}
interface Workspace {
  preview: { status: string; previewOrigin: string; entryUrl: string };
  versionLabel: string;
  devices: FrameDevice[];
  appOrigin: string;
}
interface PublicFeedback {
  id: string;
  key: string;
  type: 'comment' | 'bug' | 'change_request';
  title: string;
  body: string;
  status: string;
  pageUrl: string;
  viewport: { width: number; height: number } | null;
  x: number | null;
  y: number | null;
  deviceKey: string | null;
  reporter: { name: string; department: string };
  mine: boolean;
  createdAt: string;
  screenshots: string[];
  comments: { author: string; body: string; createdAt: string }[];
}
type Picked = Extract<BridgeMessage, { type: 'picked' }>;

const STATUS: Record<string, [string, string]> = {
  open: ['Alındı', 'var(--muted)'],
  triaged: ['İnceleniyor', 'var(--run)'],
  planned: ['Planlandı', 'var(--run)'],
  in_progress: ['Üzerinde çalışılıyor', 'var(--run)'],
  ready_for_review: ['Onayınızı bekliyor', 'var(--amber)'],
  resolved: ['Çözüldü', 'var(--ok)'],
  rejected: ['Kapatıldı', 'var(--muted)'],
};
const TYPE: [PublicFeedback['type'], string][] = [
  ['change_request', 'Değişiklik'],
  ['bug', 'Hata'],
  ['comment', 'Yorum'],
];

const base = (token: string) => `/public/reviews/${token}`;
const pathOf = (url: string) => {
  try {
    const u = new URL(url);
    return u.pathname + u.search;
  } catch {
    return url;
  }
};

/** Customer review portal (spec §54–66): no account, just a time-limited link. */
export default function ReviewPortalPage() {
  const { token } = useParams<{ token: string }>();
  const q = useQuery({ queryKey: ['public', token], queryFn: () => api<Describe>(base(token)), retry: false });
  if (q.isLoading) return <Loading label="Yükleniyor…" />;
  if (q.error)
    return (
      <div className="gate">
        <div className="card">
          <h1>Bağlantı bulunamadı</h1>
          <p className="muted">{q.error instanceof ApiError && q.error.status === 404 ? 'Bağlantı hatalı ya da kaldırılmış olabilir. Size gönderilen bağlantıyı kontrol edin.' : errorMessage(q.error)}</p>
        </div>
      </div>
    );
  const d = q.data!;
  // Custom accent (spec §141): the portal's primary colour follows the project's branding.
  return (
    <div style={{ display: 'contents', ...(d.branding.accent ? ({ '--primary': d.branding.accent } as CSSProperties) : {}) }}>
      {d.status !== 'active' ? <Closed d={d} /> : !d.visitor ? <Gate token={token} d={d} /> : <Portal token={token} d={d} />}
    </div>
  );
}

/** Project logo when uploaded, otherwise the initials badge. */
function ProjectMark({ d, size = 42 }: { d: Describe; size?: number }) {
  if (d.branding.projectLogo) return <img src={d.branding.projectLogo} alt={d.project.name} className="p-logo" style={{ width: size, height: size, objectFit: 'contain', background: '#fff' }} />;
  return (
    <span className="p-logo" style={{ background: d.branding.accent ?? d.project.color, width: size, height: size, fontSize: size < 40 ? 12 : 16 }}>
      {d.project.short}
    </span>
  );
}

function Logo({ src, alt, height = 28 }: { src: string | null; alt: string; height?: number }) {
  return src ? <img src={src} alt={alt} style={{ height, maxWidth: 140, objectFit: 'contain', flex: 'none' }} /> : null;
}

function Closed({ d }: { d: Describe }) {
  return (
    <div className="gate">
      <div className="card">
        <div className="small muted">{d.project.name}</div>
        <h1>{d.status === 'revoked' ? 'Bu bağlantı kapatıldı' : 'Bu bağlantının süresi doldu'}</h1>
        <p>{d.review.name}</p>
        <p className="muted">Ön izlemeyi tekrar görmek için proje ekibinden yeni bir bağlantı isteyin. Bıraktığınız geri bildirimler ekip tarafından saklanıyor.</p>
        {d.contact && (
          <p>
            İletişim: <b>{d.contact.name}</b> · <a href={`mailto:${d.contact.email}`}>{d.contact.email}</a>
          </p>
        )}
      </div>
    </div>
  );
}

function Gate({ token, d }: { token: string; d: Describe }) {
  const qc = useQueryClient();
  const [v, setV] = useState({ firstName: '', lastName: '', department: '', otherDepartment: '', company: d.project.customerName, email: '', password: '' });
  const set = (k: keyof typeof v) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => setV((x) => ({ ...x, [k]: e.target.value }));
  const department = v.department === 'Diğer' ? v.otherDepartment.trim() : v.department;
  const identify = useMutation({
    mutationFn: () =>
      api<Describe>(`${base(token)}/identify`, {
        method: 'POST',
        body: { firstName: v.firstName.trim(), lastName: v.lastName.trim(), department, company: v.company.trim(), email: v.email.trim(), password: d.review.passwordRequired ? v.password : undefined },
      }),
    onSuccess: (r) => qc.setQueryData(['public', token], r),
  });
  const ok = v.firstName.trim() && v.lastName.trim() && department && (!d.review.passwordRequired || v.password) && (!v.email || /.+@.+\..+/.test(v.email));
  return (
    <div className="gate">
      <div className="card">
        {d.branding.companyLogo && (
          <div style={{ marginBottom: 14 }}>
            <Logo src={d.branding.companyLogo} alt="Şirket logosu" height={32} />
          </div>
        )}
        <div className="row" style={{ marginBottom: 14 }}>
          <ProjectMark d={d} />
          <div style={{ flex: 1 }}>
            <div className="small muted">{d.project.customerName || 'Proje incelemesi'}</div>
            <b>{d.project.name}</b>
          </div>
          <Logo src={d.branding.customerLogo} alt={d.project.customerName || 'Kullanıcı logosu'} height={32} />
        </div>
        <h1>{d.review.name}</h1>
        <p className="muted">
          {d.review.versionLabel} sürümünü inceleyip sayfanın üzerinde işaretleyerek geri bildirim bırakabilirsiniz. Bağlantı {dateTime(d.review.expiresAt)} tarihine kadar geçerli.
        </p>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (ok) identify.mutate();
          }}
        >
          <div className="grid g2">
            <Field label="Adınız" id="g-fn">
              <input id="g-fn" className="in" value={v.firstName} onChange={set('firstName')} autoComplete="given-name" maxLength={80} autoFocus />
            </Field>
            <Field label="Soyadınız" id="g-ln">
              <input id="g-ln" className="in" value={v.lastName} onChange={set('lastName')} autoComplete="family-name" maxLength={80} />
            </Field>
          </div>
          <div className="grid g2">
            <Field label="Biriminiz" id="g-dep" hint="Geri bildirimleri doğru kişiye yönlendirmek için">
              <select id="g-dep" className="in" value={v.department} onChange={set('department')}>
                <option value="">Seçin</option>
                {DEPARTMENTS.map((x) => (
                  <option key={x}>{x}</option>
                ))}
              </select>
            </Field>
            {v.department === 'Diğer' ? (
              <Field label="Birim adı" id="g-od">
                <input id="g-od" className="in" value={v.otherDepartment} onChange={set('otherDepartment')} maxLength={120} />
              </Field>
            ) : (
              <Field label="Firma" id="g-co">
                <input id="g-co" className="in" value={v.company} onChange={set('company')} autoComplete="organization" maxLength={150} />
              </Field>
            )}
          </div>
          <Field label="E-posta (isteğe bağlı)" id="g-em" hint="Geri bildiriminiz güncellenince haberdar olmak isterseniz">
            <input id="g-em" className="in" type="email" value={v.email} onChange={set('email')} autoComplete="email" maxLength={255} />
          </Field>
          {d.review.passwordRequired && (
            <Field label="Bağlantı şifresi" id="g-pw" hint="Proje ekibinin size ilettiği şifre">
              <input id="g-pw" className="in" type="password" value={v.password} onChange={set('password')} autoComplete="off" />
            </Field>
          )}
          {identify.error && <div className="badbox" style={{ marginBottom: 10 }}>{errorMessage(identify.error)}</div>}
          <button className="btn pri" style={{ width: '100%', justifyContent: 'center' }} disabled={!ok || identify.isPending}>
            {identify.isPending && <span className="spinner" />} İncelemeye başla
          </button>
        </form>
        {d.contact && (
          <p className="small muted" style={{ marginBottom: 0 }}>
            Sorunuz olursa: {d.contact.name} · {d.contact.email}
          </p>
        )}
      </div>
    </div>
  );
}

function Portal({ token, d }: { token: string; d: Describe }) {
  const qc = useQueryClient();
  const toast = useToast();
  const caps = d.review.capabilities;
  const ws = useQuery({ queryKey: ['publicWs', token], queryFn: () => api<Workspace>(`${base(token)}/workspace`) });
  const fb = useQuery({ queryKey: ['publicFb', token], queryFn: () => api<PublicFeedback[]>(`${base(token)}/feedback`) });
  const frame = useRef<HTMLIFrameElement>(null);
  const overlay = useRef<HTMLDivElement>(null);
  const [deviceKey, setDeviceKey] = useState<string>('');
  const [path, setPath] = useState('/');
  const [scrollY, setScrollY] = useState(0);
  const [picking, setPicking] = useState(false);
  const [picked, setPicked] = useState<Picked | null>(null);
  const [tab, setTab] = useState<'feedback' | 'chat' | 'info'>('feedback');
  const [src, setSrc] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const lastHover = useRef(0);
  // Pins are positioned in scaled frame coordinates; re-render when the frame is resized.
  const [, setFrameWidth] = useState(0);
  useEffect(() => {
    const el = overlay.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setFrameWidth(el.getBoundingClientRect().width));
    ro.observe(el);
    return () => ro.disconnect();
  });

  const devices = ws.data?.devices ?? [];
  const deviceList = useMemo(() => {
    const pick = (cat: FrameDevice['category']) => devices.filter((x) => x.category === cat);
    return caps.deviceSwitch ? [...pick('desktop').slice(0, 2), ...pick('tablet').slice(0, 2), ...pick('phone').slice(0, 3)] : pick('desktop').slice(0, 1);
  }, [devices, caps.deviceSwitch]);
  const device = deviceList.find((x) => x.key === deviceKey) ?? deviceList[0];
  const origin = ws.data?.preview.previewOrigin ?? null;

  useEffect(() => {
    if (ws.data) setSrc(ws.data.preview.entryUrl);
  }, [ws.data, reloadKey]);

  const send = useBridge(frame, origin, (m) => {
    if (m.type === 'nav') {
      setPath(m.path);
      setScrollY(m.scrollY);
    } else if (m.type === 'scroll') setScrollY(m.scrollY);
    else if (m.type === 'picked') {
      setPicked(m);
      setPicking(false);
      setTab('feedback');
    }
  });

  // Live updates: team replies, status changes, a new version behind the same link, link closed.
  useEffect(() => {
    const es = new EventSource(`/api/v1${base(token)}/events`);
    es.addEventListener('message', () => void qc.invalidateQueries({ queryKey: ['publicChat', token] }));
    es.addEventListener('feedback', () => void qc.invalidateQueries({ queryKey: ['publicFb', token] }));
    es.addEventListener('review', (e) => {
      const data = JSON.parse((e as MessageEvent).data) as { newVersion: boolean };
      void qc.invalidateQueries({ queryKey: ['public', token] });
      if (data.newVersion) {
        toast('Yeni sürüm yayında; ön izleme yenilendi');
        void qc.invalidateQueries({ queryKey: ['publicWs', token] }).then(() => setReloadKey((k) => k + 1));
      }
    });
    return () => es.close();
  }, [token, qc, toast]);

  const scale = () => (overlay.current && device ? overlay.current.getBoundingClientRect().width / device.width : 1);
  const toFrame = (e: React.MouseEvent) => {
    const r = overlay.current!.getBoundingClientRect();
    const s = scale();
    return { x: (e.clientX - r.left) / s, y: (e.clientY - r.top) / s };
  };
  const pins = (fb.data ?? []).filter((f) => f.x !== null && f.y !== null && pathOf(f.pageUrl) === path && (!f.deviceKey || f.deviceKey === device?.key));

  if (ws.isLoading || !device) return <Loading label="Ön izleme hazırlanıyor…" />;
  if (ws.error) return <div className="gate"><div className="badbox">{errorMessage(ws.error)}</div></div>;

  return (
    <div className="portal">
      <div className="portal-top">
        <Logo src={d.branding.companyLogo} alt="Şirket logosu" />
        <ProjectMark d={d} size={32} />
        <div style={{ minWidth: 0 }}>
          <div className="pname">{d.project.name}</div>
          <div className="small muted">
            {d.review.name} · {ws.data!.versionLabel} · {until(d.review.expiresAt)}
          </div>
        </div>
        <Logo src={d.branding.customerLogo} alt={d.project.customerName || 'Kullanıcı logosu'} />
        <div style={{ flex: 1 }} />
        {caps.deviceSwitch && (
          <select className="in" style={{ width: 'auto' }} value={device.key} onChange={(e) => setDeviceKey(e.target.value)} aria-label="Cihaz">
            {deviceList.map((x) => (
              <option key={x.key} value={x.key}>
                {x.name} · {x.width}×{x.height}
              </option>
            ))}
          </select>
        )}
        <button className="btn" title="Yenile" onClick={() => send({ type: 'reload' })}>
          <RefreshCw />
        </button>
        {caps.feedback && (
          <button className={`btn ${picking ? 'danger solid' : 'pri'}`} onClick={() => (setPicking((p) => !p), setPicked(null))}>
            {picking ? <X /> : <MousePointerClick />} {picking ? 'İşaretlemeyi bırak' : 'Geri bildirim bırak'}
          </button>
        )}
        <span className="small muted">
          {d.visitor!.firstName} {d.visitor!.lastName} <span className="dept">{d.visitor!.department}</span>
        </span>
      </div>
      <div className="portal-body">
        <div className="portal-stage">
          {picking && <div className="ai-note small" style={{ position: 'sticky', top: 0, zIndex: 5, marginBottom: 10 }}>Sayfada geri bildirim vermek istediğiniz yere tıklayın.</div>}
          {ws.data!.preview.status !== 'ready' ? (
            <div className="warnbox">Ön izleme şu an hazırlanıyor. Birkaç saniye sonra yenileyin.</div>
          ) : (
            <DeviceFrame
              device={device}
              src={src}
              frameRef={frame}
              title={`${d.project.name} ön izleme`}
              maxHeight={typeof window !== 'undefined' ? window.innerHeight - 140 : 720}
              overlay={
                <>
                  {pins.map((f) => {
                    const s = scale();
                    const top = (f.y! - scrollY) * s;
                    if (top < -20 || top > device.height * s) return null;
                    return (
                      <button key={f.id} className="pin" style={{ left: f.x! * s, top, zIndex: 4, border: 0, cursor: 'pointer', pointerEvents: picking ? 'none' : 'auto', opacity: picking ? 0.6 : 1 }} title={`${f.key}: ${f.title}`} onClick={() => (setTab('feedback'), document.getElementById(`fb-${f.id}`)?.scrollIntoView({ behavior: 'smooth' }))}>
                        <span>{f.key.replace('FB-', '')}</span>
                      </button>
                    );
                  })}
                  {picked && <div className="pin" style={{ left: picked.x * scale(), top: (picked.y - scrollY) * scale(), background: 'var(--primary)', zIndex: 4, pointerEvents: 'none' }}><span>+</span></div>}
                  {picking && (
                    <div
                      ref={overlay}
                      className="fb-overlay"
                      onMouseMove={(e) => {
                        const now = Date.now();
                        if (now - lastHover.current < 60) return;
                        lastHover.current = now;
                        send({ type: 'hover', ...toFrame(e) });
                      }}
                      onMouseLeave={() => send({ type: 'clearHover' })}
                      onClick={(e) => send({ type: 'pick', requestId: String(Date.now()), ...toFrame(e) })}
                    />
                  )}
                  {!picking && <div ref={overlay} style={{ position: 'absolute', inset: 0, pointerEvents: 'none' }} />}
                </>
              }
            />
          )}
        </div>
        <aside className="portal-side">
          <div style={{ padding: '8px 12px 0' }}>
            <Tabs
              value={tab}
              onChange={setTab}
              items={[
                ['feedback', `Geri bildirimler${fb.data ? ` (${fb.data.length})` : ''}`],
                ...(caps.chat ? ([['chat', 'Ekiple yazış']] as ['chat', string][]) : []),
                ['info', 'Bilgi'],
              ]}
            />
          </div>
          <div style={{ flex: 1, minHeight: 0, overflow: 'auto', display: 'flex', flexDirection: 'column' }}>
            {tab === 'feedback' &&
              (picked ? (
                <FeedbackForm
                  token={token}
                  picked={picked}
                  device={device}
                  origin={origin!}
                  screenshots={caps.screenshots}
                  onCancel={() => setPicked(null)}
                  onDone={() => {
                    setPicked(null);
                    void qc.invalidateQueries({ queryKey: ['publicFb', token] });
                  }}
                />
              ) : (
                <FeedbackList
                  token={token}
                  items={fb.data ?? []}
                  canWrite={caps.feedback}
                  onShow={(f) => {
                    if (f.deviceKey && deviceList.some((x) => x.key === f.deviceKey)) setDeviceKey(f.deviceKey);
                    const p = pathOf(f.pageUrl);
                    if (p !== path) send({ type: 'navigate', path: p });
                    if (f.y !== null) setTimeout(() => send({ type: 'scrollTo', y: Math.max(0, f.y! - 120) }), p !== path ? 900 : 0);
                  }}
                />
              ))}
            {tab === 'chat' && caps.chat && <Chat token={token} />}
            {tab === 'info' && <Info token={token} d={d} canDocs={caps.docs} />}
          </div>
        </aside>
      </div>
    </div>
  );
}

function FeedbackForm({ token, picked, device, origin, screenshots, onCancel, onDone }: { token: string; picked: Picked; device: FrameDevice; origin: string; screenshots: boolean; onCancel: () => void; onDone: () => void }) {
  const toast = useToast();
  const [type, setType] = useState<PublicFeedback['type']>('change_request');
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [shot, setShot] = useState(screenshots);
  const submit = useMutation({
    mutationFn: () =>
      api<{ key: string }>(`${base(token)}/feedback`, {
        method: 'POST',
        body: {
          type,
          title: title.trim(),
          body: body.trim(),
          pageUrl: `${origin}${picked.path}`,
          viewport: { width: device.width, height: device.height },
          scrollY: picked.scrollY,
          coordinates: { x: picked.x, y: picked.y },
          domSelector: picked.selector,
          deviceKey: device.key,
          captureScreenshot: shot,
        },
      }),
    onSuccess: (r) => {
      toast(`Teşekkürler, geri bildiriminiz alındı (${r.key})`);
      onDone();
    },
  });
  return (
    <div style={{ padding: 14 }}>
      <div className="small muted" style={{ marginBottom: 8 }}>
        <span className="mono">{picked.path}</span> · {device.name}
        {picked.text && <div className="ellipsis">“{picked.text}”</div>}
      </div>
      <Field label="Tür" id="pf-type">
        <Segmented value={type} onChange={setType} items={TYPE} />
      </Field>
      <Field label="Başlık" id="pf-title">
        <input id="pf-title" className="in" value={title} onChange={(e) => setTitle(e.target.value)} maxLength={200} autoFocus placeholder={type === 'bug' ? 'ör. Ödeme butonu çalışmıyor' : 'ör. Başlık daha büyük olsun'} />
      </Field>
      <Field label="Açıklama" id="pf-body">
        <textarea id="pf-body" className="in" value={body} onChange={(e) => setBody(e.target.value)} maxLength={5000} placeholder="Ne görmeyi beklediniz, ne gördünüz?" />
      </Field>
      {screenshots && (
        <label className="check">
          <input type="checkbox" checked={shot} onChange={(e) => setShot(e.target.checked)} /> Ekran görüntüsü ekle
        </label>
      )}
      {submit.error && <div className="badbox">{errorMessage(submit.error)}</div>}
      <div className="row" style={{ marginTop: 10 }}>
        <button className="btn pri" disabled={!title.trim() || submit.isPending} onClick={() => submit.mutate()}>
          {submit.isPending && <span className="spinner" />} Gönder
        </button>
        <button className="btn" onClick={onCancel}>
          Vazgeç
        </button>
      </div>
    </div>
  );
}

function FeedbackList({ token, items, canWrite, onShow }: { token: string; items: PublicFeedback[]; canWrite: boolean; onShow: (f: PublicFeedback) => void }) {
  const [only, setOnly] = useState<'all' | 'mine'>('all');
  const rows = only === 'mine' ? items.filter((f) => f.mine) : items;
  if (!items.length)
    return (
      <div style={{ padding: 16 }} className="small muted">
        {canWrite ? (
          <>
            Henüz geri bildirim yok. Üstteki <b>Geri bildirim bırak</b> düğmesine basıp sayfada ilgili yere tıklayın.
          </>
        ) : (
          'Bu bağlantıda geri bildirim kapalı.'
        )}
      </div>
    );
  return (
    <div style={{ padding: 12 }}>
      <Segmented value={only} onChange={setOnly} items={[['all', 'Tümü'], ['mine', 'Benimkiler']]} />
      {rows.map((f) => (
        <FeedbackCard key={f.id} token={token} f={f} onShow={() => onShow(f)} />
      ))}
    </div>
  );
}

function FeedbackCard({ token, f, onShow }: { token: string; f: PublicFeedback; onShow: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [reply, setReply] = useState('');
  const refresh = () => void qc.invalidateQueries({ queryKey: ['publicFb', token] });
  const comment = useMutation({ mutationFn: () => api(`${base(token)}/feedback/${f.id}/comments`, { method: 'POST', body: { body: reply } }), onSuccess: () => (setReply(''), refresh()), onError: (e) => toast(errorMessage(e), 'bad') });
  const decide = useMutation({
    mutationFn: (decision: 'approve' | 'reject') => api(`${base(token)}/feedback/${f.id}/decision`, { method: 'POST', body: { decision, comment: reply || undefined } }),
    onSuccess: (_, d) => (toast(d === 'approve' ? 'Onayınız iletildi' : 'Ekibe yeniden düzeltme isteğiniz iletildi'), setReply(''), refresh()),
    onError: (e) => toast(errorMessage(e), 'bad'),
  });
  const [label, color] = STATUS[f.status] ?? [f.status, 'var(--muted)'];
  return (
    <div id={`fb-${f.id}`} className="panel" style={{ padding: 12, marginTop: 10 }}>
      <div className="spread small">
        <span className="mono muted">{f.key}</span>
        <span style={{ color, fontWeight: 600 }}>{label}</span>
      </div>
      <button onClick={onShow} style={{ all: 'unset', cursor: 'pointer', display: 'block', fontWeight: 600, margin: '4px 0' }} title="Sayfada göster">
        {f.title}
      </button>
      {f.body && <div style={{ whiteSpace: 'pre-wrap', fontSize: 13 }}>{f.body}</div>}
      <div className="small muted" style={{ marginTop: 4 }}>
        {f.reporter.name} · {ago(f.createdAt)} · <span className="mono">{pathOf(f.pageUrl)}</span>
      </div>
      {f.screenshots.map((id) => (
        <a key={id} href={`/api/v1${base(token)}/attachments/${id}`} target="_blank" rel="noreferrer">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={`/api/v1${base(token)}/attachments/${id}`} alt={`${f.key} ekran görüntüsü`} style={{ width: '100%', marginTop: 8, borderRadius: 6, border: '1px solid var(--line)' }} />
        </a>
      ))}
      {f.comments.map((c, i) => (
        <div key={i} className="small" style={{ marginTop: 8, paddingLeft: 8, borderLeft: '2px solid var(--line)' }}>
          <b>{c.author}</b> <span className="muted">{ago(c.createdAt)}</span>
          <div style={{ whiteSpace: 'pre-wrap' }}>{c.body}</div>
        </div>
      ))}
      <div className="row" style={{ marginTop: 8, flexWrap: 'nowrap' }}>
        <input className="in" style={{ padding: '5px 8px', fontSize: 13 }} placeholder={f.status === 'ready_for_review' ? 'Not (isteğe bağlı)' : 'Yanıt yazın'} value={reply} onChange={(e) => setReply(e.target.value)} maxLength={5000} />
        {f.status !== 'ready_for_review' && (
          <button className="btn sm" disabled={!reply.trim() || comment.isPending} onClick={() => comment.mutate()}>
            <Send size={14} />
          </button>
        )}
      </div>
      {f.status === 'ready_for_review' && (
        <div className="row" style={{ marginTop: 8 }}>
          <button className="btn sm pri" onClick={() => decide.mutate('approve')} disabled={decide.isPending}>
            Düzeldi, onaylıyorum
          </button>
          <button className="btn sm" onClick={() => decide.mutate('reject')} disabled={decide.isPending}>
            Hâlâ düzeltilmeli
          </button>
        </div>
      )}
    </div>
  );
}

function Chat({ token }: { token: string }) {
  const qc = useQueryClient();
  const [text, setText] = useState('');
  const end = useRef<HTMLDivElement>(null);
  const q = useQuery({ queryKey: ['publicChat', token], queryFn: () => api<{ id: string; authorType: string; author: string; body: string; createdAt: string }[]>(`${base(token)}/messages`) });
  const send = useMutation({
    mutationFn: () => api<typeof q.data>(`${base(token)}/messages`, { method: 'POST', body: { body: text } }),
    onSuccess: (msgs) => {
      qc.setQueryData(['publicChat', token], msgs);
      setText('');
    },
  });
  useEffect(() => {
    void end.current?.scrollIntoView({ block: 'end' });
  }, [q.data]);
  return (
    <>
      <div className="chat">
        {!q.data?.length && <p className="small muted">Proje ekibine soru sorabilir veya not bırakabilirsiniz.</p>}
        {q.data?.map((m) => (
          <div key={m.id} className={`msg ${m.authorType === 'customer' ? 'me' : 'ai'}`}>
            <div className="small" style={{ opacity: 0.8, marginBottom: 2 }}>
              {m.author} · {time(m.createdAt)}
            </div>
            {m.body}
          </div>
        ))}
        <div ref={end} />
      </div>
      <form
        className="chat-in"
        onSubmit={(e) => {
          e.preventDefault();
          if (text.trim()) send.mutate();
        }}
      >
        <input className="in" value={text} onChange={(e) => setText(e.target.value)} placeholder="Mesajınız" maxLength={4000} />
        <button className="btn pri" disabled={!text.trim() || send.isPending} title="Gönder">
          <MessageSquarePlus />
        </button>
      </form>
      {send.error && <div className="badbox">{errorMessage(send.error)}</div>}
    </>
  );
}

function Info({ token, d, canDocs }: { token: string; d: Describe; canDocs: boolean }) {
  const q = useQuery({ queryKey: ['publicDocs', token], queryFn: () => api<{ name: string; description: string; customerName: string; versions: { version: string; notes: string; releasedAt: string | null; createdAt: string }[] }>(`${base(token)}/docs`), enabled: canDocs });
  return (
    <div style={{ padding: 14 }}>
      <dl className="kv">
        <dt>İnceleme</dt>
        <dd>{d.review.name}</dd>
        <dt>Sürüm</dt>
        <dd>{d.review.versionLabel}</dd>
        <dt>Geçerlilik</dt>
        <dd>{dateTime(d.review.expiresAt)}</dd>
        {d.contact && (
          <>
            <dt>İletişim</dt>
            <dd>
              {d.contact.name}
              <div className="small">
                <a href={`mailto:${d.contact.email}`}>{d.contact.email}</a>
              </div>
            </dd>
          </>
        )}
      </dl>
      {canDocs && q.data && (
        <>
          {q.data.description && <p style={{ marginTop: 16 }}>{q.data.description}</p>}
          {q.data.versions.map((v) => (
            <div key={v.version} style={{ marginTop: 12 }}>
              <b>v{v.version}</b> <span className="small muted">{ago(v.releasedAt ?? v.createdAt)}</span>
              <Markdown text={v.notes || '_Sürüm notu yok._'} className="prose small" />
            </div>
          ))}
        </>
      )}
      <p className="small muted" style={{ marginTop: 16 }}>
        Telefon ve tablet görünümleri tarayıcıda simüle edilir; son kontrolü gerçek cihazda yapmanızı öneririz.
      </p>
    </div>
  );
}
