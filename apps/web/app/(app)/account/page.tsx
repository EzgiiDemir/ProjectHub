'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { api, errorMessage } from '@/lib/api';
import { ago, dateTime } from '@/lib/format';
import { useMe } from '@/lib/hooks';
import { Async, CopyButton, Field, PageHeader, Panel } from '@/components/ui';
import { useToast } from '@/components/toast';

interface Session {
  id: string;
  ipAddress: string | null;
  userAgent: string;
  createdAt: string;
  lastSeenAt: string;
  expiresAt: string;
  current: boolean;
}
interface Token {
  id: string;
  name: string;
  prefix: string;
  lastUsedAt: string | null;
  expiresAt: string | null;
  createdAt: string;
}

function device(ua: string) {
  const browser = /Edg\//.test(ua) ? 'Edge' : /Chrome\//.test(ua) ? 'Chrome' : /Firefox\//.test(ua) ? 'Firefox' : /Safari\//.test(ua) ? 'Safari' : /^git\//.test(ua) ? 'Git' : /curl/.test(ua) ? 'curl' : 'Tarayıcı';
  const os = /Windows/.test(ua) ? 'Windows' : /Mac OS X/.test(ua) ? 'macOS' : /Android/.test(ua) ? 'Android' : /iPhone|iPad/.test(ua) ? 'iOS' : /Linux/.test(ua) ? 'Linux' : '';
  return [browser, os].filter(Boolean).join(' · ');
}

/** Personal account: profile, password, active sessions and personal access tokens (for Git over HTTPS). */
export default function AccountPage() {
  const me = useMe().data;
  if (!me) return <div className="page" />;
  return (
    <div className="page" style={{ maxWidth: 1000 }}>
      <PageHeader title="Hesabım" sub={me.user.email} />
      <div className="grid g2" style={{ alignItems: 'start' }}>
        <Profile displayName={me.user.displayName} title={me.user.title} />
        <Password />
      </div>
      <Notifications />
      <Tokens />
      <Sessions />
    </div>
  );
}

type Pref = { inApp?: boolean; email?: boolean };
const NOTIFICATION_LABELS: [string, string, string][] = [
  ['code', 'Kod', "Pull request açılması, inceleme ve birleştirme"],
  ['build', "Build'ler", "Başarısız build'ler"],
  ['deployment', "Deployment'lar", 'Onay bekleyen, başarısız veya geri alınan yayınlar'],
  ['feedback', 'Geri bildirim', 'Kullanıcı yorumları ve hata bildirimleri'],
  ['ai', 'AI', 'Onay bekleyen veya tamamlanan AI görevleri'],
  ['security', 'Güvenlik', 'Kritik güvenlik bulguları'],
  ['incident', 'Olaylar', 'Erişilemeyen ortamlar ve olay kayıtları'],
  ['team', 'Takım çalışması', 'Size atanan görevler, görevlerinize yorumlar ve tartışmada sizden bahsedilmesi'],
];

/** Per-category notification channels; the worker's dispatcher honours them for every event. */
function Notifications() {
  const qc = useQueryClient();
  const toast = useToast();
  const q = useQuery({ queryKey: ['notification-preferences'], queryFn: () => api<{ preferences: Record<string, Pref>; emailEnabled: boolean }>('/auth/notification-preferences') });
  const save = useMutation({
    mutationFn: (preferences: Record<string, Pref>) => api('/auth/notification-preferences', { method: 'PUT', body: preferences }),
    onSuccess: (data) => {
      qc.setQueryData(['notification-preferences'], data);
      toast('Bildirim tercihleri kaydedildi');
    },
    onError: (e) => toast(errorMessage(e), 'bad'),
  });
  return (
    <Panel title="Bildirimler" flush>
      <Async q={q} rows={4}>
        {({ preferences, emailEnabled }) => {
          const set = (cat: string, patch: Pref) => {
            // email: undefined ("Varsayılan") is dropped by JSON serialisation, i.e. falls back to the event's default.
            save.mutate({ ...preferences, [cat]: { ...preferences[cat], ...patch } });
          };
          return (
            <>
              {!emailEnabled && <div className="small muted" style={{ padding: '10px 16px 0' }}>Sunucuda e-posta (SMTP) yapılandırılmadığı için e-posta bildirimleri şu an gönderilmiyor; tercihleriniz yapılandırıldığında uygulanır.</div>}
              <div className="tbl">
                <table>
                  <thead>
                    <tr>
                      <th>Konu</th>
                      <th>Uygulama içi</th>
                      <th>E-posta</th>
                    </tr>
                  </thead>
                  <tbody>
                    {NOTIFICATION_LABELS.map(([cat, label, hint]) => {
                      const p = preferences[cat] ?? {};
                      return (
                        <tr key={cat}>
                          <td>
                            {label}
                            <div className="small muted">{hint}</div>
                          </td>
                          <td>
                            <label className="check" style={{ margin: 0 }}>
                              <input type="checkbox" checked={p.inApp ?? true} disabled={save.isPending} onChange={(e) => set(cat, { inApp: e.target.checked })} aria-label={`${label} uygulama içi`} />
                              {p.inApp ?? true ? 'Açık' : 'Kapalı'}
                            </label>
                          </td>
                          <td>
                            <select
                              className="in"
                              style={{ minWidth: 230 }}
                              value={p.email === undefined ? 'default' : p.email ? 'on' : 'off'}
                              disabled={save.isPending}
                              onChange={(e) => set(cat, { email: e.target.value === 'default' ? undefined : e.target.value === 'on' })}
                              aria-label={`${label} e-posta`}
                            >
                              <option value="default">Varsayılan (önemli olaylar)</option>
                              <option value="on">Her zaman</option>
                              <option value="off">Hiçbir zaman</option>
                            </select>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </>
          );
        }}
      </Async>
    </Panel>
  );
}

function Profile({ displayName, title }: { displayName: string; title: string }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [v, setV] = useState({ displayName, title });
  const save = useMutation({
    mutationFn: () => api('/auth/profile', { method: 'PATCH', body: v }),
    onSuccess: () => {
      toast('Profil güncellendi');
      void qc.invalidateQueries({ queryKey: ['me'] });
    },
  });
  return (
    <Panel title="Profil">
      <Field label="Ad soyad" id="ac-name">
        <input id="ac-name" className="in" value={v.displayName} onChange={(e) => setV((x) => ({ ...x, displayName: e.target.value }))} maxLength={150} />
      </Field>
      <Field label="Ünvan" id="ac-title">
        <input id="ac-title" className="in" value={v.title} onChange={(e) => setV((x) => ({ ...x, title: e.target.value }))} maxLength={120} />
      </Field>
      {save.error && <div className="badbox">{errorMessage(save.error)}</div>}
      <button className="btn pri" disabled={!v.displayName.trim() || save.isPending} onClick={() => save.mutate()}>
        Kaydet
      </button>
    </Panel>
  );
}

function Password() {
  const toast = useToast();
  const qc = useQueryClient();
  const [v, setV] = useState({ currentPassword: '', newPassword: '', repeat: '' });
  const change = useMutation({
    mutationFn: () => api('/auth/password', { method: 'POST', body: { currentPassword: v.currentPassword, newPassword: v.newPassword } }),
    onSuccess: () => {
      toast('Parola değişti; diğer oturumlar kapatıldı');
      setV({ currentPassword: '', newPassword: '', repeat: '' });
      void qc.invalidateQueries({ queryKey: ['sessions'] });
    },
  });
  const strong = v.newPassword.length >= 12 && /\p{L}/u.test(v.newPassword) && /\d/.test(v.newPassword);
  return (
    <Panel title="Parola">
      <Field label="Mevcut parola" id="pw-cur">
        <input id="pw-cur" className="in" type="password" value={v.currentPassword} onChange={(e) => setV((x) => ({ ...x, currentPassword: e.target.value }))} autoComplete="current-password" />
      </Field>
      <Field label="Yeni parola" id="pw-new" hint="En az 12 karakter, harf ve rakam içermeli" error={v.newPassword && !strong ? 'En az 12 karakter, harf ve rakam' : null}>
        <input id="pw-new" className="in" type="password" value={v.newPassword} onChange={(e) => setV((x) => ({ ...x, newPassword: e.target.value }))} autoComplete="new-password" />
      </Field>
      <Field label="Yeni parola (tekrar)" id="pw-rep" error={v.repeat && v.repeat !== v.newPassword ? 'Parolalar aynı değil' : null}>
        <input id="pw-rep" className="in" type="password" value={v.repeat} onChange={(e) => setV((x) => ({ ...x, repeat: e.target.value }))} autoComplete="new-password" />
      </Field>
      {change.error && <div className="badbox">{errorMessage(change.error)}</div>}
      <button className="btn pri" disabled={!v.currentPassword || !strong || v.repeat !== v.newPassword || change.isPending} onClick={() => change.mutate()}>
        Parolayı değiştir
      </button>
    </Panel>
  );
}

function Tokens() {
  const qc = useQueryClient();
  const toast = useToast();
  const [name, setName] = useState('');
  const [days, setDays] = useState('90');
  const [created, setCreated] = useState<{ name: string; token: string } | null>(null);
  const q = useQuery({ queryKey: ['tokens'], queryFn: () => api<Token[]>('/auth/tokens') });
  const create = useMutation({
    mutationFn: () => api<{ name: string; token: string }>('/auth/tokens', { method: 'POST', body: { name, expiresInDays: days ? Number(days) : null } }),
    onSuccess: (t) => {
      setCreated(t);
      setName('');
      void qc.invalidateQueries({ queryKey: ['tokens'] });
    },
  });
  const revoke = useMutation({
    mutationFn: (id: string) => api(`/auth/tokens/${id}`, { method: 'DELETE' }),
    onSuccess: () => (toast('Anahtar iptal edildi'), void qc.invalidateQueries({ queryKey: ['tokens'] })),
    onError: (e) => toast(errorMessage(e), 'bad'),
  });
  return (
    <Panel title="Erişim anahtarları" className="mt">
      <p className="small muted" style={{ marginTop: 0 }}>
        Git ile klonlama ve gönderme (HTTPS) için parola yerine kullanılır: kullanıcı adı e-postanız, parola anahtarın kendisi. Anahtar yalnızca oluşturulduğunda bir kez gösterilir.
      </p>
      <div className="row" style={{ alignItems: 'flex-end', marginBottom: 10 }}>
        <Field label="Ad" id="tk-name">
          <input id="tk-name" className="in" value={name} onChange={(e) => setName(e.target.value)} placeholder="ör. iş bilgisayarı git" maxLength={100} />
        </Field>
        <Field label="Geçerlilik" id="tk-days">
          <select id="tk-days" className="in" value={days} onChange={(e) => setDays(e.target.value)}>
            <option value="30">30 gün</option>
            <option value="90">90 gün</option>
            <option value="365">1 yıl</option>
            <option value="">Süresiz</option>
          </select>
        </Field>
        <div className="field">
          <button className="btn pri" disabled={!name.trim() || create.isPending} onClick={() => create.mutate()}>
            Oluştur
          </button>
        </div>
      </div>
      {create.error && <div className="badbox">{errorMessage(create.error)}</div>}
      {created && (
        <div className="okbox" style={{ marginBottom: 10 }}>
          <div className="small" style={{ marginBottom: 6 }}>
            <b>{created.name}</b> oluşturuldu. Şimdi kopyalayın; bir daha gösterilmeyecek.
          </div>
          <div className="row" style={{ flexWrap: 'nowrap' }}>
            <code className="small ellipsis" style={{ flex: 1 }}>
              {created.token}
            </code>
            <CopyButton text={created.token} />
          </div>
        </div>
      )}
      <Async q={q}>
        {(rows) =>
          rows.length ? (
            <div className="tbl">
              <table>
                <tbody>
                  {rows.map((t) => (
                    <tr key={t.id}>
                      <td>
                        <b>{t.name}</b> <span className="mono small muted">{t.prefix}…</span>
                      </td>
                      <td className="small muted">son kullanım {t.lastUsedAt ? ago(t.lastUsedAt) : 'hiç'}</td>
                      <td className="small muted">{t.expiresAt ? `bitiş ${dateTime(t.expiresAt)}` : 'süresiz'}</td>
                      <td style={{ textAlign: 'right' }}>
                        <button className="btn sm ghost" onClick={() => revoke.mutate(t.id)} disabled={revoke.isPending}>
                          İptal et
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <p className="small muted">Anahtar yok.</p>
          )
        }
      </Async>
    </Panel>
  );
}

function Sessions() {
  const qc = useQueryClient();
  const toast = useToast();
  const q = useQuery({ queryKey: ['sessions'], queryFn: () => api<Session[]>('/auth/sessions') });
  const revoke = useMutation({
    mutationFn: (id: string) => api(`/auth/sessions/${id}`, { method: 'DELETE' }),
    onSuccess: () => (toast('Oturum kapatıldı'), void qc.invalidateQueries({ queryKey: ['sessions'] })),
    onError: (e) => toast(errorMessage(e), 'bad'),
  });
  return (
    <Panel title="Açık oturumlar" className="mt" flush>
      <Async q={q}>
        {(rows) => (
          <div className="tbl">
            <table>
              <tbody>
                {rows.map((s) => (
                  <tr key={s.id}>
                    <td>
                      {device(s.userAgent)} {s.current && <span className="small" style={{ color: 'var(--ok)' }}>· bu oturum</span>}
                      <div className="small muted mono">{s.ipAddress ?? '—'}</div>
                    </td>
                    <td className="small muted">açıldı {ago(s.createdAt)}</td>
                    <td className="small muted">son etkinlik {ago(s.lastSeenAt)}</td>
                    <td style={{ textAlign: 'right' }}>
                      {!s.current && (
                        <button className="btn sm ghost" onClick={() => revoke.mutate(s.id)} disabled={revoke.isPending}>
                          Kapat
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Async>
    </Panel>
  );
}
