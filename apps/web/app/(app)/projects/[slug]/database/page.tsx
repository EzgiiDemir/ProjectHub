'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { api, errorMessage } from '@/lib/api';
import { ago, bytes, dateTime } from '@/lib/format';
import { useProject, useProjectSlug } from '@/lib/hooks';
import type { Environment } from '@/lib/types';
import { Async, ConfirmDialog, Drawer, Empty, Field, KeyValue, Panel, StatusBadge, Tabs } from '@/components/ui';
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

interface Overview {
  latestVersion: string | null;
  environments: { environment: { id: string; name: string; type: string }; currentVersion: string | null; appliedCount: number; pending: { id: string; name: string; riskLevel: string; version: string }[]; lastBackup: { id: string; createdAt: string; verifiedAt: string | null } | null }[];
}
interface Migration {
  id: string;
  path: string;
  name: string;
  riskLevel: string;
  operations: string[];
  version: string;
  detectedAt: string;
  environments: { id: string; name: string; appliedAt: string | null }[];
}
interface Restore {
  id: string;
  backupId: string;
  environmentId: string;
  environmentName: string;
  status: string;
  error: string | null;
  requestedByName: string | null;
  canApprove: boolean;
  createdAt: string;
  finishedAt: string | null;
}

/**
 * Per-environment database connections, migration state, verified pg_dump backups and restores (spec §51–53).
 * Credentials are stored encrypted; a restore always takes a safety backup first and production needs a second person.
 */
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
  const [tab, setTab] = useState<'backups' | 'migrations' | 'restores'>('backups');
  const [restoring, setRestoring] = useState<Backup | null>(null);
  const [removing, setRemoving] = useState<Backup | null>(null);
  const overview = useQuery({ queryKey: ['db-overview', slug], queryFn: () => api<Overview>(`/projects/${slug}/database/overview`) });
  const restores = useQuery({
    queryKey: ['restores', slug],
    queryFn: () => api<Restore[]>(`/projects/${slug}/restores`),
    refetchInterval: (q) => ((q.state.data ?? []).some((r) => r.status === 'queued' || r.status === 'running') ? 3000 : false),
  });
  const canManage = !!project?.permissions.includes('database.manage') && project.status !== 'archived';
  const refresh = () => ['backups', 'restores', 'db-overview'].forEach((k) => void qc.invalidateQueries({ queryKey: [k] }));
  const verify = useMutation({
    mutationFn: (id: string) => api(`/backups/${id}/verify`, { method: 'POST' }),
    onSuccess: () => {
      toast('Doğrulama başladı');
      setTimeout(refresh, 2500);
    },
    onError: (e) => toast(errorMessage(e), 'bad'),
  });
  const remove = useMutation({
    mutationFn: (id: string) => api(`/backups/${id}`, { method: 'DELETE' }),
    onSuccess: () => {
      toast('Yedek silindi');
      setRemoving(null);
      refresh();
    },
    onError: (e) => toast(errorMessage(e), 'bad'),
  });
  const decide = useMutation({
    mutationFn: ({ id, approve }: { id: string; approve: boolean }) => api(`/restores/${id}/${approve ? 'approve' : 'reject'}`, { method: 'POST' }),
    onSuccess: (_d, v) => {
      toast(v.approve ? 'Geri yükleme onaylandı' : 'Geri yükleme reddedildi');
      refresh();
    },
    onError: (e) => toast(errorMessage(e), 'bad'),
  });
  const pendingApprovals = (restores.data ?? []).filter((r) => r.status === 'pending_approval').length;
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
                    <EnvState o={overview.data?.environments.find((x) => x.environment.id === e.id)} latest={overview.data?.latestVersion ?? null} />
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
      <Tabs
        value={tab}
        onChange={setTab}
        items={[
          ['backups', 'Yedekler'],
          ['migrations', "Migration'lar"],
          ['restores', <span key="r">Geri yüklemeler{pendingApprovals > 0 && <span className="tag" style={{ marginLeft: 6 }}>{pendingApprovals} onay bekliyor</span>}</span>],
        ]}
      />
      {tab === 'migrations' && <MigrationsTable slug={slug} />}
      {tab === 'restores' && (
        <Panel flush>
          <Async q={restores} rows={3}>
            {(rows) =>
              rows.length ? (
                <div className="tbl">
                  <table>
                    <thead>
                      <tr>
                        <th>İstek</th>
                        <th>Hedef ortam</th>
                        <th>İsteyen</th>
                        <th>Durum</th>
                        <th />
                      </tr>
                    </thead>
                    <tbody>
                      {rows.map((r) => (
                        <tr key={r.id}>
                          <td className="small">{dateTime(r.createdAt)}</td>
                          <td>{r.environmentName}</td>
                          <td className="small">{r.requestedByName ?? '—'}</td>
                          <td>
                            <StatusBadge status={r.status} />
                            {r.error && <div className="small" style={{ color: 'var(--bad)' }}>{r.error}</div>}
                          </td>
                          <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                            {r.canApprove && (
                              <>
                                <button className="btn sm pri" disabled={decide.isPending} onClick={() => decide.mutate({ id: r.id, approve: true })}>
                                  Onayla
                                </button>{' '}
                                <button className="btn sm" disabled={decide.isPending} onClick={() => decide.mutate({ id: r.id, approve: false })}>
                                  Reddet
                                </button>
                              </>
                            )}
                            {r.status === 'pending_approval' && !r.canApprove && <span className="small muted">Başka bir veritabanı yöneticisi onaylamalı</span>}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                <Empty title="Geri yükleme yok">Yedekler sekmesinden bir yedeği bir ortama geri yükleyebilirsiniz. Production geri yüklemeleri ikinci bir kişinin onayını bekler.</Empty>
              )
            }
          </Async>
        </Panel>
      )}
      {tab === 'backups' && (
      <Panel flush>
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
                      <th>Doğrulama</th>
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
                        <td className="small">{b.deploymentId ? 'Deployment öncesi' : b.versionLabel === 'geri-yükleme-öncesi' ? 'Geri yükleme öncesi' : 'Elle'}</td>
                        <td>
                          <StatusBadge status={b.status} />
                          {b.error && <div className="small" style={{ color: 'var(--bad)' }}>{b.error}</div>}
                        </td>
                        <td className="mono small">{bytes(b.sizeBytes)}</td>
                        <td className="small">{b.verifiedAt ? <span title={dateTime(b.verifiedAt)} style={{ color: 'var(--ok)' }}>✓ Okunabilir</span> : b.status === 'completed' ? <span className="muted">Doğrulanmadı</span> : '—'}</td>
                        <td className="small muted">{b.expiresAt ? dateTime(b.expiresAt) : '—'}</td>
                        <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                          {b.status === 'completed' && canManage && (
                            <>
                              <button className="btn sm" onClick={() => setRestoring(b)}>
                                Geri yükle
                              </button>{' '}
                              <button className="btn sm" disabled={verify.isPending} onClick={() => verify.mutate(b.id)}>
                                Doğrula
                              </button>{' '}
                              <a className="btn sm" href={`/api/v1/backups/${b.id}/download`}>
                                İndir
                              </a>
                            </>
                          )}{' '}
                          {canManage && b.status !== 'running' && (
                            <button className="btn sm danger" onClick={() => setRemoving(b)}>
                              Sil
                            </button>
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
      )}
      {editing && <ConnectionDrawer slug={slug} env={editing} onClose={() => setEditing(null)} />}
      {restoring && envs.data && (
        <RestoreDialog
          backup={restoring}
          envs={envs.data.filter((e) => e.database)}
          onClose={() => setRestoring(null)}
          onDone={() => {
            setRestoring(null);
            setTab('restores');
            refresh();
          }}
        />
      )}
      {removing && (
        <ConfirmDialog
          title="Yedeği sil"
          message={<>{removing.environmentName ?? ''} ortamının {dateTime(removing.createdAt)} tarihli yedeği kalıcı olarak silinecek. Production yedekleri ilk 7 gün silinemez.</>}
          actionLabel="Sil"
          busy={remove.isPending}
          onConfirm={() => remove.mutate(removing.id)}
          onClose={() => setRemoving(null)}
        />
      )}
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

function EnvState({ o, latest }: { o: Overview['environments'][number] | undefined; latest: string | null }) {
  if (!o) return null;
  const high = o.pending.filter((m) => m.riskLevel === 'high').length;
  return (
    <div className="small" style={{ marginBottom: 10, display: 'grid', gap: 2 }}>
      <div>
        Yayındaki sürüm: <b>{o.currentVersion ? `v${o.currentVersion}` : '—'}</b>
        {latest && o.currentVersion !== latest && <span className="muted"> (son: v{latest})</span>}
      </div>
      <div>
        Migration: {o.appliedCount} uygulandı
        {o.pending.length > 0 && (
          <span style={{ color: high ? 'var(--bad)' : 'var(--warn)' }}>
            {' '}
            · {o.pending.length} bekliyor{high ? ` (${high} yüksek riskli)` : ''}
          </span>
        )}
      </div>
      <div>
        Son yedek:{' '}
        {o.lastBackup ? (
          <>
            {ago(o.lastBackup.createdAt)} {o.lastBackup.verifiedAt ? <span style={{ color: 'var(--ok)' }}>✓ doğrulandı</span> : <span className="muted">doğrulanmadı</span>}
          </>
        ) : (
          <span style={{ color: 'var(--warn)' }}>hiç alınmadı</span>
        )}
      </div>
    </div>
  );
}

function MigrationsTable({ slug }: { slug: string }) {
  const q = useQuery({ queryKey: ['migrations', slug], queryFn: () => api<Migration[]>(`/projects/${slug}/migrations`) });
  return (
    <Panel flush>
      <Async q={q} rows={3}>
        {(rows) =>
          rows.length ? (
            <div className="tbl">
              <table>
                <thead>
                  <tr>
                    <th>Migration</th>
                    <th>Geldiği sürüm</th>
                    <th>Risk</th>
                    {rows[0]!.environments.map((e) => (
                      <th key={e.id}>{e.name}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {rows.map((m) => (
                    <tr key={m.id}>
                      <td>
                        <span className="mono small">{m.path}</span>
                        {m.operations.length > 0 && <div className="small muted">{m.operations.join(', ')}</div>}
                      </td>
                      <td className="small">v{m.version}</td>
                      <td>
                        <StatusBadge status={m.riskLevel} />
                      </td>
                      {m.environments.map((e) => (
                        <td key={e.id} className="small">
                          {e.appliedAt ? (
                            <span title={dateTime(e.appliedAt)} style={{ color: 'var(--ok)' }}>
                              ✓ {ago(e.appliedAt)}
                            </span>
                          ) : (
                            <span className="muted">Bekliyor</span>
                          )}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <Empty title="Migration kaydı yok">Manifestte database.migrate.directory tanımlıysa, versiyon oluşturulurken o klasördeki yeni migration&apos;lar burada izlenir.</Empty>
          )
        }
      </Async>
    </Panel>
  );
}

function RestoreDialog({ backup, envs, onClose, onDone }: { backup: Backup; envs: Environment[]; onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const [envId, setEnvId] = useState(backup.environmentId && envs.some((e) => e.id === backup.environmentId) ? backup.environmentId : (envs[0]?.id ?? ''));
  const env = envs.find((e) => e.id === envId);
  const restore = useMutation({
    mutationFn: () => api<{ status: string }>(`/backups/${backup.id}/restore`, { method: 'POST', body: { environmentId: envId } }),
    onSuccess: (r) => {
      toast(r.status === 'pending_approval' ? 'Geri yükleme ikinci bir kişinin onayını bekliyor' : 'Geri yükleme başladı');
      onDone();
    },
    onError: (e) => toast(errorMessage(e), 'bad'),
  });
  return (
    <ConfirmDialog
      title="Yedeği geri yükle"
      message={
        <>
          {dateTime(backup.createdAt)} tarihli {backup.versionLabel ? `${backup.versionLabel} ` : ''}yedeği seçilen ortamın veritabanına yüklenecek. O veritabanı tamamen yedekteki hale döner; önce otomatik bir güvenlik yedeği alınır.
        </>
      }
      confirmText={env?.type === 'production' ? env.name : undefined}
      actionLabel={env?.type === 'production' ? 'Onaya gönder' : 'Geri yükle'}
      busy={restore.isPending || !env}
      onConfirm={() => restore.mutate()}
      onClose={onClose}
    >
      {envs.length ? (
        <Field label="Hedef ortam" id="rs-env" hint={env?.type === 'production' ? 'Production geri yüklemesi başka bir veritabanı yöneticisinin onayından sonra çalışır.' : undefined}>
          <select id="rs-env" className="in" value={envId} onChange={(e) => setEnvId(e.target.value)}>
            {envs.map((e) => (
              <option key={e.id} value={e.id}>
                {e.name} · {e.database!.databaseName}
              </option>
            ))}
          </select>
        </Field>
      ) : (
        <div className="badbox small">Veritabanı bağlantısı tanımlı bir ortam yok.</div>
      )}
    </ConfirmDialog>
  );
}
