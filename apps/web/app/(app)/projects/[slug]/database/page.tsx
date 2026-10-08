'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { api, errorMessage } from '@/lib/api';
import { ago, bytes, dateTime } from '@/lib/format';
import { useProject, useProjectSlug } from '@/lib/hooks';
import type { Environment } from '@/lib/types';
import { Async, Drawer, Empty, Field, KeyValue, Panel, StatusBadge } from '@/components/ui';
import { useToast } from '@/components/toast';

interface Backup {
  id: string;
  environmentId: string | null;
  environmentName: string | null;
  versionLabel: string | null;
  deploymentId: string | null;
  type: string;
  status: string;
  sizeBytes: number;
  error: string | null;
  createdAt: string;
  verifiedAt: string | null;
  expiresAt: string | null;
}

/** Per-environment database connections and pg_dump backups (spec §91, §104). Credentials are stored encrypted. */
export default function DatabasePage() {
  const slug = useProjectSlug();
  const qc = useQueryClient();
  const toast = useToast();
  const project = useProject().data;
  const [editing, setEditing] = useState<Environment | null>(null);
  const envs = useQuery({ queryKey: ['environments', slug], queryFn: () => api<Environment[]>(`/projects/${slug}/environments`) });
  const backups = useQuery({
    queryKey: ['backups', slug],
    queryFn: () => api<Backup[]>(`/projects/${slug}/backups`),
    refetchInterval: (q) => ((q.state.data ?? []).some((b) => b.status === 'running') ? 3000 : false),
  });
  const canManage = !!project?.permissions.includes('database.manage') && project.status !== 'archived';
  const backup = useMutation({
    mutationFn: (environmentId: string) => api(`/projects/${slug}/backups`, { method: 'POST', body: { environmentId } }),
    onSuccess: () => {
      toast('Yedekleme başladı');
      void qc.invalidateQueries({ queryKey: ['backups'] });
    },
    onError: (e) => toast(errorMessage(e), 'bad'),
  });

  return (
    <>
      <div style={{ marginBottom: 12 }}>
        <h2 style={{ margin: 0 }}>Veritabanı</h2>
        <p className="sub">Ortam başına PostgreSQL bağlantısı. Deployment öncesi otomatik yedek ve elle yedek alma bu bağlantıyı kullanır.</p>
      </div>
      <Async q={envs} rows={3}>
        {(list) => (
          <div className="grid g3" style={{ alignItems: 'start', marginBottom: 14 }}>
            {list.map((e) => (
              <Panel key={e.id} title={e.name}>
                {e.database ? (
                  <>
                    <KeyValue
                      items={[
                        ['Sunucu', <span key="h" className="mono small">{e.database.host}:{e.database.port}</span>],
                        ['Veritabanı', <span key="d" className="mono small">{e.database.databaseName}</span>],
                        ['Kullanıcı', <span key="u" className="mono small">{e.database.username}</span>],
                        ['SSL', e.database.sslMode],
                        [
                          'Son kontrol',
                          e.database.lastCheckedAt ? (
                            <span key="c">
                              {e.database.lastCheckOk ? <StatusBadge status="healthy" label="Bağlandı" /> : <StatusBadge status="down" label="Bağlanamadı" />} <span className="small muted">{ago(e.database.lastCheckedAt)}</span>
                              {e.database.lastCheckMessage && <div className="small muted">{e.database.lastCheckMessage}</div>}
                            </span>
                          ) : (
                            'bekleniyor'
                          ),
                        ],
                      ]}
                    />
                    {canManage && (
                      <div className="row" style={{ marginTop: 12 }}>
                        <button className="btn" onClick={() => setEditing(e)}>
                          Düzenle
                        </button>
                        <button className="btn pri" onClick={() => backup.mutate(e.id)} disabled={backup.isPending}>
                          Şimdi yedekle
                        </button>
                      </div>
                    )}
                  </>
                ) : (
                  <>
                    <p className="small muted" style={{ marginTop: 0 }}>Bağlantı tanımlı değil.</p>
                    {canManage && (
                      <button className="btn" onClick={() => setEditing(e)}>
                        Bağlantı ekle
                      </button>
                    )}
                  </>
                )}
              </Panel>
            ))}
          </div>
        )}
      </Async>
      <Panel title="Yedekler" flush>
        <Async q={backups} rows={3}>
          {(rows) =>
            rows.length ? (
              <div className="tbl">
                <table>
                  <thead>
                    <tr>
                      <th>Zaman</th>
                      <th>Ortam</th>
                      <th>Kaynak</th>
                      <th>Durum</th>
                      <th>Boyut</th>
                      <th>Saklama</th>
                      <th />
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((b) => (
                      <tr key={b.id}>
                        <td className="small">{dateTime(b.createdAt)}</td>
                        <td>
                          {b.environmentName ?? '—'} {b.versionLabel && <span className="tag">{b.versionLabel}</span>}
                        </td>
                        <td className="small">{b.deploymentId ? 'Deployment öncesi' : 'Elle'}</td>
                        <td>
                          <StatusBadge status={b.status} />
                          {b.error && <div className="small" style={{ color: 'var(--bad)' }}>{b.error}</div>}
                        </td>
                        <td className="mono small">{bytes(b.sizeBytes)}</td>
                        <td className="small muted">{b.expiresAt ? dateTime(b.expiresAt) : '—'}</td>
                        <td style={{ textAlign: 'right' }}>
                          {b.status === 'completed' && canManage && (
                            <a className="btn sm" href={`/api/v1/backups/${b.id}/download`}>
                              İndir
                            </a>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <Empty title="Yedek yok">Bağlantı tanımlandığında deployment öncesi yedekler burada listelenir.</Empty>
            )
          }
        </Async>
      </Panel>
      {editing && <ConnectionDrawer slug={slug} env={editing} onClose={() => setEditing(null)} />}
    </>
  );
}

function ConnectionDrawer({ slug, env, onClose }: { slug: string; env: Environment; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const db = env.database;
  const [v, setV] = useState({ host: db?.host ?? '', port: String(db?.port ?? 5432), database: db?.databaseName ?? '', username: db?.username ?? '', password: '', sslMode: (db?.sslMode ?? 'prefer') as 'disable' | 'prefer' | 'require' });
  const set = <K extends keyof typeof v>(k: K, val: (typeof v)[K]) => setV((x) => ({ ...x, [k]: val }));
  const save = useMutation({
    mutationFn: () => api(`/projects/${slug}/database`, { method: 'PUT', body: { environmentId: env.id, host: v.host, port: Number(v.port) || 5432, database: v.database, username: v.username, password: v.password || undefined, sslMode: v.sslMode } }),
    onSuccess: () => {
      toast('Bağlantı kaydedildi; bağlantı kontrol ediliyor');
      void qc.invalidateQueries({ queryKey: ['environments'] });
      onClose();
    },
  });
  return (
    <Drawer
      title={`${env.name} veritabanı`}
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            Vazgeç
          </button>
          <button className="btn pri" disabled={!v.host || !v.database || !v.username || (!db?.hasPassword && !v.password) || save.isPending} onClick={() => save.mutate()}>
            Kaydet ve test et
          </button>
        </>
      }
    >
      <p className="small muted" style={{ marginTop: 0 }}>Şu an PostgreSQL desteklenir. Yedek için kullanıcının pg_dump ile okuma yetkisi olmalı.</p>
      <div className="grid g2">
        <Field label="Sunucu" id="db-host">
          <input id="db-host" className="in mono" value={v.host} onChange={(e) => set('host', e.target.value)} />
        </Field>
        <Field label="Port" id="db-port">
          <input id="db-port" className="in mono" value={v.port} onChange={(e) => set('port', e.target.value.replace(/\D/g, ''))} />
        </Field>
        <Field label="Veritabanı" id="db-name">
          <input id="db-name" className="in mono" value={v.database} onChange={(e) => set('database', e.target.value)} />
        </Field>
        <Field label="Kullanıcı" id="db-user">
          <input id="db-user" className="in mono" value={v.username} onChange={(e) => set('username', e.target.value)} autoComplete="off" />
        </Field>
        <Field label="Parola" id="db-pw" hint={db?.hasPassword ? 'Kayıtlı. Boş bırakılırsa korunur.' : 'Şifrelenerek saklanır.'}>
          <input id="db-pw" className="in" type="password" value={v.password} onChange={(e) => set('password', e.target.value)} autoComplete="new-password" />
        </Field>
        <Field label="SSL" id="db-ssl">
          <select id="db-ssl" className="in" value={v.sslMode} onChange={(e) => set('sslMode', e.target.value as typeof v.sslMode)}>
            <option value="disable">Kapalı</option>
            <option value="prefer">Varsa kullan</option>
            <option value="require">Zorunlu</option>
          </select>
        </Field>
      </div>
      {save.error && <div className="badbox">{errorMessage(save.error)}</div>}
    </Drawer>
  );
}
