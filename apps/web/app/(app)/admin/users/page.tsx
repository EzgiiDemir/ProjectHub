'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus, UserPlus } from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';
import { api, errorMessage } from '@/lib/api';
import { ago } from '@/lib/format';
import { useMe } from '@/lib/hooks';
import type { Role } from '@/lib/types';
import { Async, Avatar, ConfirmDialog, CopyButton, Drawer, Field, KeyValue, Modal, PageHeader, Panel, StatusBadge, Tabs } from '@/components/ui';
import { useToast } from '@/components/toast';

interface AdminUser {
  id: string;
  email: string;
  displayName: string;
  title: string;
  avatarColor: string;
  status: 'invited' | 'active' | 'suspended';
  lastLoginAt: string | null;
  lastActivityAt: string | null;
  joinedAt: string;
  roles: { id: string; key: string; name: string }[];
  teams: { id: string; name: string }[];
  projectCount: number;
}
interface UserDetail extends AdminUser {
  projects: { id: string; name: string; slug: string; roleName: string | null }[];
  sessions: { id: string; ipAddress: string | null; userAgent: string; lastSeenAt: string }[];
  activity: { id: string; action: string; actorLabel: string; createdAt: string; resourceType: string }[];
  permissions: string[];
}
interface Team {
  id: string;
  name: string;
  memberIds: string[];
}

/** People and teams (spec §115–118). Access is role based; invitations are single-use links. */
export default function AdminUsersPage() {
  const [tab, setTab] = useState<'users' | 'teams'>('users');
  return (
    <div className="page">
      <PageHeader title="Kullanıcılar ve ekipler" sub="Davet, rol atama, askıya alma ve ekip yönetimi. Tüm işlemler denetim kaydına yazılır." />
      <Tabs
        value={tab}
        onChange={setTab}
        items={[
          ['users', 'Kullanıcılar'],
          ['teams', 'Ekipler'],
        ]}
      />
      {tab === 'users' ? <Users /> : <Teams />}
    </div>
  );
}

function Users() {
  const [inviting, setInviting] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const q = useQuery({ queryKey: ['adminUsers'], queryFn: () => api<AdminUser[]>('/admin/users') });
  return (
    <>
      <div className="spread" style={{ marginBottom: 10 }}>
        <input className="in" style={{ maxWidth: 320 }} placeholder="Ad veya e-posta ara" value={search} onChange={(e) => setSearch(e.target.value)} />
        <button className="btn pri" onClick={() => setInviting(true)}>
          <UserPlus /> Kullanıcı davet et
        </button>
      </div>
      <Async q={q} rows={5}>
        {(all) => {
          const s = search.trim().toLocaleLowerCase('tr-TR');
          const rows = s ? all.filter((u) => `${u.displayName} ${u.email}`.toLocaleLowerCase('tr-TR').includes(s)) : all;
          return (
            <Panel flush>
              <div className="tbl">
                <table>
                  <thead>
                    <tr>
                      <th />
                      <th>Kullanıcı</th>
                      <th>Roller</th>
                      <th>Ekipler</th>
                      <th>Proje</th>
                      <th>Durum</th>
                      <th>Son giriş</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((u) => (
                      <tr key={u.id} className="click" onClick={() => setOpenId(u.id)}>
                        <td style={{ width: 40 }}>
                          <Avatar name={u.displayName} color={u.avatarColor} />
                        </td>
                        <td>
                          <b>{u.displayName}</b> <span className="small muted">{u.title}</span>
                          <div className="small muted">{u.email}</div>
                        </td>
                        <td className="small">{u.roles.map((r) => r.name).join(', ')}</td>
                        <td className="small">{u.teams.map((t) => t.name).join(', ') || '—'}</td>
                        <td>{u.projectCount}</td>
                        <td>
                          <StatusBadge status={u.status} />
                        </td>
                        <td className="small muted">{u.lastLoginAt ? ago(u.lastLoginAt) : 'hiç'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Panel>
          );
        }}
      </Async>
      {inviting && <Invite onClose={() => setInviting(false)} />}
      {openId && <UserDrawer id={openId} onClose={() => setOpenId(null)} />}
    </>
  );
}

function RolePicker({ value, onChange }: { value: string[]; onChange: (ids: string[]) => void }) {
  const roles = useQuery({ queryKey: ['roles'], queryFn: () => api<Role[]>('/admin/roles') });
  return (
    <div className="field">
      <label>Roller</label>
      {roles.data?.map((r) => (
        <label key={r.id} className="check" style={{ alignItems: 'flex-start' }}>
          <input type="checkbox" checked={value.includes(r.id)} onChange={(e) => onChange(e.target.checked ? [...value, r.id] : value.filter((x) => x !== r.id))} />
          <span>
            {r.name}
            {r.description && <div className="small muted">{r.description}</div>}
          </span>
        </label>
      ))}
    </div>
  );
}

function Invite({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient();
  const [v, setV] = useState({ email: '', displayName: '', roleIds: [] as string[] });
  const [result, setResult] = useState<{ invitationUrl: string | null; emailed: boolean; existingAccount: boolean } | null>(null);
  const invite = useMutation({
    mutationFn: () => api<{ invitationUrl: string | null; emailed: boolean; existingAccount: boolean }>('/admin/users', { method: 'POST', body: v }),
    onSuccess: (r) => {
      setResult(r);
      void qc.invalidateQueries({ queryKey: ['adminUsers'] });
      void qc.invalidateQueries({ queryKey: ['directory'] });
    },
  });
  return (
    <Modal
      title="Kullanıcı davet et"
      onClose={onClose}
      footer={
        result ? (
          <button className="btn pri" onClick={onClose}>
            Tamam
          </button>
        ) : (
          <>
            <button className="btn" onClick={onClose}>
              Vazgeç
            </button>
            <button className="btn pri" disabled={!v.email.includes('@') || !v.displayName.trim() || !v.roleIds.length || invite.isPending} onClick={() => invite.mutate()}>
              Davet et
            </button>
          </>
        )
      }
    >
      {result ? (
        result.existingAccount ? (
          <div className="okbox">Bu e-postanın hesabı vardı; kullanıcı organizasyona eklendi ve seçilen roller verildi.</div>
        ) : (
          <>
            <div className="okbox" style={{ marginBottom: 10 }}>
              Davet oluşturuldu{result.emailed ? ' ve e-posta gönderildi' : ''}. {!result.emailed && 'E-posta sunucusu tanımlı olmadığı için bağlantıyı kendiniz iletin.'}
            </div>
            {result.invitationUrl && (
              <div className="row" style={{ flexWrap: 'nowrap' }}>
                <code className="small ellipsis" style={{ flex: 1 }}>
                  {result.invitationUrl}
                </code>
                <CopyButton text={result.invitationUrl} />
              </div>
            )}
          </>
        )
      ) : (
        <>
          <div className="grid g2">
            <Field label="Ad soyad" id="iv-name">
              <input id="iv-name" className="in" value={v.displayName} onChange={(e) => setV((x) => ({ ...x, displayName: e.target.value }))} />
            </Field>
            <Field label="E-posta" id="iv-mail">
              <input id="iv-mail" className="in" type="email" value={v.email} onChange={(e) => setV((x) => ({ ...x, email: e.target.value }))} />
            </Field>
          </div>
          <RolePicker value={v.roleIds} onChange={(roleIds) => setV((x) => ({ ...x, roleIds }))} />
          {invite.error && <div className="badbox">{errorMessage(invite.error)}</div>}
        </>
      )}
    </Modal>
  );
}

function UserDrawer({ id, onClose }: { id: string; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const me = useMe().data;
  const q = useQuery({ queryKey: ['adminUser', id], queryFn: () => api<UserDetail>(`/admin/users/${id}`) });
  const [roleIds, setRoleIds] = useState<string[] | null>(null);
  const [link, setLink] = useState<{ label: string; url: string; emailed: boolean } | null>(null);
  const [suspending, setSuspending] = useState(false);
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['adminUser', id] });
    void qc.invalidateQueries({ queryKey: ['adminUsers'] });
  };
  const update = useMutation({
    mutationFn: (body: Record<string, unknown>) => api(`/admin/users/${id}`, { method: 'PATCH', body }),
    onSuccess: () => (toast('Kullanıcı güncellendi'), setRoleIds(null), setSuspending(false), refresh()),
    onError: (e) => toast(errorMessage(e), 'bad'),
  });
  const resetSessions = useMutation({ mutationFn: () => api(`/admin/users/${id}/reset-sessions`, { method: 'POST' }), onSuccess: () => (toast('Tüm oturumlar kapatıldı'), refresh()), onError: (e) => toast(errorMessage(e), 'bad') });
  const resend = useMutation({
    mutationFn: () => api<{ invitationUrl: string; emailed: boolean }>(`/admin/users/${id}/resend-invite`, { method: 'POST' }),
    onSuccess: (r) => setLink({ label: 'Yeni davet bağlantısı', url: r.invitationUrl, emailed: r.emailed }),
    onError: (e) => toast(errorMessage(e), 'bad'),
  });
  const resetLink = useMutation({
    mutationFn: () => api<{ url: string; emailed: boolean }>(`/admin/users/${id}/password-reset-link`, { method: 'POST' }),
    onSuccess: (r) => setLink({ label: 'Şifre sıfırlama bağlantısı', url: r.url, emailed: r.emailed }),
    onError: (e) => toast(errorMessage(e), 'bad'),
  });
  return (
    <Drawer title={q.data?.displayName ?? 'Kullanıcı'} onClose={onClose} wide>
      <Async q={q}>
        {(u) => {
          const self = u.id === me?.user.id;
          const current = roleIds ?? u.roles.map((r) => r.id);
          return (
            <>
              <div className="row" style={{ marginBottom: 12 }}>
                <Avatar name={u.displayName} color={u.avatarColor} size={40} />
                <div>
                  <b>{u.displayName}</b> <StatusBadge status={u.status} />
                  <div className="small muted">{u.email}</div>
                </div>
              </div>
              {link && (
                <div className="okbox" style={{ marginBottom: 12 }}>
                  <div className="small" style={{ marginBottom: 6 }}>
                    {link.label}
                    {link.emailed ? ' e-postayla gönderildi.' : ' oluşturuldu; kullanıcıya iletin.'}
                  </div>
                  <div className="row" style={{ flexWrap: 'nowrap' }}>
                    <code className="small ellipsis" style={{ flex: 1 }}>
                      {link.url}
                    </code>
                    <CopyButton text={link.url} />
                  </div>
                </div>
              )}
              <div className="grid g2" style={{ alignItems: 'start' }}>
                <div>
                  <RolePicker value={current} onChange={setRoleIds} />
                  {roleIds && (
                    <button className="btn pri" disabled={!roleIds.length || update.isPending} onClick={() => update.mutate({ roleIds })}>
                      Rolleri kaydet
                    </button>
                  )}
                  <p className="small muted">Bir kullanıcıya yalnızca sizin de sahip olduğunuz yetkileri içeren roller verebilirsiniz.</p>
                </div>
                <div>
                  <KeyValue
                    items={[
                      ['Katılım', ago(u.joinedAt)],
                      ['Son giriş', u.lastLoginAt ? ago(u.lastLoginAt) : 'hiç'],
                      ['Ekipler', u.teams.map((t) => t.name).join(', ') || '—'],
                      ['Etkin yetki', `${u.permissions.length} yetki`],
                      ['Açık oturum', u.sessions.length],
                    ]}
                  />
                  <div className="row" style={{ marginTop: 12 }}>
                    {u.status === 'invited' && (
                      <button className="btn" onClick={() => resend.mutate()} disabled={resend.isPending}>
                        Daveti yenile
                      </button>
                    )}
                    {u.status === 'active' && (
                      <button className="btn" onClick={() => resetLink.mutate()} disabled={resetLink.isPending}>
                        Şifre sıfırlama bağlantısı
                      </button>
                    )}
                    {!self && u.sessions.length > 0 && (
                      <button className="btn" onClick={() => resetSessions.mutate()} disabled={resetSessions.isPending}>
                        Oturumları kapat
                      </button>
                    )}
                    {!self && u.status === 'active' && (
                      <button className="btn danger" onClick={() => setSuspending(true)}>
                        Askıya al
                      </button>
                    )}
                    {!self && u.status === 'suspended' && (
                      <button className="btn" onClick={() => update.mutate({ status: 'active' })} disabled={update.isPending}>
                        Yeniden etkinleştir
                      </button>
                    )}
                  </div>
                </div>
              </div>
              <h3 style={{ margin: '18px 0 8px' }}>Projeler</h3>
              {u.projects.length ? (
                <div className="row">
                  {u.projects.map((p) => (
                    <Link key={p.id} className="tag" href={`/projects/${p.slug}/settings?tab=members`}>
                      {p.name}
                      {p.roleName ? ` · ${p.roleName}` : ''}
                    </Link>
                  ))}
                </div>
              ) : (
                <p className="small muted">Proje üyeliği yok.</p>
              )}
              <h3 style={{ margin: '18px 0 8px' }}>Son işlemler</h3>
              {u.activity.length ? (
                <div className="mono small">
                  {u.activity.slice(0, 20).map((a) => (
                    <div key={a.id} style={{ padding: '2px 0' }}>
                      <span className="muted">{ago(a.createdAt)}</span> {a.action}
                    </div>
                  ))}
                </div>
              ) : (
                <p className="small muted">Kayıt yok.</p>
              )}
              {suspending && (
                <ConfirmDialog
                  title="Kullanıcıyı askıya al"
                  message={`${u.displayName} giriş yapamaz ve açık oturumları kapanır; erişim anahtarları askı süresince çalışmaz. Verileri ve geçmişi korunur.`}
                  actionLabel="Askıya al"
                  busy={update.isPending}
                  onConfirm={() => update.mutate({ status: 'suspended' })}
                  onClose={() => setSuspending(false)}
                />
              )}
            </>
          );
        }}
      </Async>
    </Drawer>
  );
}

function Teams() {
  const qc = useQueryClient();
  const toast = useToast();
  const [name, setName] = useState('');
  const [deleting, setDeleting] = useState<Team | null>(null);
  const teams = useQuery({ queryKey: ['teams'], queryFn: () => api<Team[]>('/admin/teams') });
  const users = useQuery({ queryKey: ['adminUsers'], queryFn: () => api<AdminUser[]>('/admin/users') });
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['teams'] });
    void qc.invalidateQueries({ queryKey: ['adminUsers'] });
  };
  const create = useMutation({ mutationFn: () => api('/admin/teams', { method: 'POST', body: { name } }), onSuccess: () => (setName(''), refresh()), onError: (e) => toast(errorMessage(e), 'bad') });
  const setMembers = useMutation({ mutationFn: ({ id, userIds }: { id: string; userIds: string[] }) => api(`/admin/teams/${id}/members`, { method: 'PUT', body: { userIds } }), onSuccess: refresh, onError: (e) => toast(errorMessage(e), 'bad') });
  const del = useMutation({ mutationFn: (id: string) => api(`/admin/teams/${id}`, { method: 'DELETE' }), onSuccess: () => (setDeleting(null), refresh()), onError: (e) => toast(errorMessage(e), 'bad') });
  return (
    <>
      <div className="row" style={{ marginBottom: 12 }}>
        <input className="in" style={{ maxWidth: 280 }} placeholder="Yeni ekip adı" value={name} onChange={(e) => setName(e.target.value)} maxLength={100} />
        <button className="btn pri" disabled={!name.trim() || create.isPending} onClick={() => create.mutate()}>
          <Plus /> Ekip oluştur
        </button>
      </div>
      <Async q={teams} rows={3}>
        {(rows) =>
          rows.length ? (
            <div className="grid g3" style={{ alignItems: 'start' }}>
              {rows.map((t) => (
                <Panel
                  key={t.id}
                  title={t.name}
                  actions={
                    <button className="btn sm ghost" onClick={() => setDeleting(t)}>
                      Sil
                    </button>
                  }
                >
                  {users.data?.map((u) => (
                    <label key={u.id} className="check">
                      <input
                        type="checkbox"
                        checked={t.memberIds.includes(u.id)}
                        onChange={(e) => setMembers.mutate({ id: t.id, userIds: e.target.checked ? [...t.memberIds, u.id] : t.memberIds.filter((x) => x !== u.id) })}
                      />
                      {u.displayName}
                    </label>
                  ))}
                </Panel>
              ))}
            </div>
          ) : (
            <p className="small muted">Ekip yok. Ekipler projeleri gruplamak ve sahiplik göstermek için kullanılır.</p>
          )
        }
      </Async>
      {deleting && (
        <ConfirmDialog
          title="Ekibi sil"
          message={`"${deleting.name}" silinir. Projeler ve kullanıcılar silinmez; projelerin ekip bilgisi boşalır.`}
          actionLabel="Sil"
          busy={del.isPending}
          onConfirm={() => del.mutate(deleting.id)}
          onClose={() => setDeleting(null)}
        />
      )}
    </>
  );
}
