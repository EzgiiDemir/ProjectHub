'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus, Rocket, Settings2 } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import type { Permission } from '@projecthub/contracts';
import { api, ApiError, errorMessage } from '@/lib/api';
import { ago, dateTime, shortSha } from '@/lib/format';
import { useProject, useProjectSlug } from '@/lib/hooks';
import { ADAPTER, ENV_TYPE } from '@/lib/labels';
import type { Deployment, Environment, Version } from '@/lib/types';
import { Async, ConfirmDialog, Drawer, Empty, Field, KeyValue, Panel, Segmented, StatusBadge, Tabs } from '@/components/ui';
import { useToast } from '@/components/toast';

/** Environments with their deployment targets, health and one-click deploys (spec §83–90). */
export default function EnvironmentsPage() {
  const slug = useProjectSlug();
  const project = useProject().data;
  const [editing, setEditing] = useState<Environment | 'new' | null>(null);
  const [deploying, setDeploying] = useState<Environment | null>(null);
  const q = useQuery({ queryKey: ['environments', slug], queryFn: () => api<Environment[]>(`/projects/${slug}/environments`) });
  const can = (p: Permission) => !!project?.permissions.includes(p);
  const archived = project?.status === 'archived';
  const canDeploy = (e: Environment) => !archived && can(e.type === 'production' ? 'deployment.production' : 'deployment.staging');

  return (
    <>
      <div className="spread" style={{ marginBottom: 12 }}>
        <div>
          <h2 style={{ margin: 0 }}>Ortamlar</h2>
          <p className="sub">Her ortamın bir yayın hedefi (sunucu klasörü, SFTP/SSH veya FTP) ve isteğe bağlı sağlık izlemesi vardır.</p>
        </div>
        {can('environment.manage') && !archived && (
          <button className="btn" onClick={() => setEditing('new')}>
            <Plus /> Ortam ekle
          </button>
        )}
      </div>
      <Async q={q} rows={3}>
        {(envs) =>
          envs.length ? (
            <div className="grid g3" style={{ alignItems: 'start' }}>
              {envs.map((e) => (
                <Panel
                  key={e.id}
                  title={
                    <span className="row" style={{ gap: 8 }}>
                      {e.name} <span className="small muted">{ENV_TYPE[e.type]}</span>
                    </span>
                  }
                  actions={
                    can('environment.manage') &&
                    !archived && (
                      <button className="icon-btn" title="Ortam ayarları" onClick={() => setEditing(e)}>
                        <Settings2 size={16} />
                      </button>
                    )
                  }
                >
                  <div className="spread" style={{ marginBottom: 10 }}>
                    <StatusBadge status={e.status} />
                    {e.currentVersion ? <span className="tag">v{e.currentVersion}</span> : <span className="small muted">yayın yok</span>}
                  </div>
                  <KeyValue
                    items={[
                      ['Adres', e.url ? <a key="u" href={e.url} target="_blank" rel="noreferrer" className="mono small">{e.url}</a> : '—'],
                      ['Hedef', e.target ? `${ADAPTER[e.target.adapter]}${e.target.host ? ` · ${e.target.host}` : ''}` : <span key="t" style={{ color: 'var(--warn)' }}>tanımlı değil</span>],
                      ['Onay', e.requiresApproval ? `${e.requiredApprovals} kişi onayı` : 'gerekmez'],
                      ['İzleme', e.monitor ? `açık · ${e.lastHealthAt ? ago(e.lastHealthAt) : 'henüz kontrol yok'}` : 'kapalı'],
                    ]}
                  />
                  {e.consecutiveFailures > 0 && <div className="badbox small" style={{ marginTop: 10 }}>Son {e.consecutiveFailures} sağlık kontrolü başarısız.</div>}
                  <div className="row" style={{ marginTop: 12 }}>
                    {canDeploy(e) && (
                      <button className="btn pri" disabled={!e.target} title={e.target ? undefined : 'Önce yayın hedefi tanımlayın'} onClick={() => setDeploying(e)}>
                        <Rocket /> Deploy
                      </button>
                    )}
                    <Link className="btn" href={`/projects/${slug}/deployments?env=${e.id}`}>
                      Geçmiş
                    </Link>
                  </div>
                </Panel>
              ))}
            </div>
          ) : (
            <Empty title="Ortam yok" />
          )
        }
      </Async>
      {editing && <EnvironmentDrawer slug={slug} env={editing === 'new' ? null : editing} onClose={() => setEditing(null)} />}
      {deploying && <DeployDrawer slug={slug} env={deploying} canOverride={can('security.manage')} onClose={() => setDeploying(null)} />}
    </>
  );
}

function EnvironmentDrawer({ slug, env, onClose }: { slug: string; env: Environment | null; onClose: () => void }) {
  const [tab, setTab] = useState<'target' | 'general' | 'health'>(env ? 'target' : 'general');
  return (
    <Drawer title={env ? `${env.name} ayarları` : 'Yeni ortam'} onClose={onClose} wide>
      {env && (
        <Tabs
          value={tab}
          onChange={setTab}
          items={[
            ['target', 'Yayın hedefi'],
            ['general', 'Genel'],
            ['health', 'Sağlık geçmişi'],
          ]}
        />
      )}
      {tab === 'general' && <GeneralForm slug={slug} env={env} onDone={onClose} />}
      {tab === 'target' && env && <TargetForm slug={slug} env={env} />}
      {tab === 'health' && env && <HealthHistory slug={slug} env={env} />}
    </Drawer>
  );
}

function GeneralForm({ slug, env, onDone }: { slug: string; env: Environment | null; onDone: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [v, setV] = useState({
    name: env?.name ?? '',
    slug: env?.slug ?? '',
    type: env?.type ?? 'custom',
    url: env?.url ?? '',
    healthPath: env?.healthPath ?? '/',
    requiresApproval: env?.requiresApproval ?? false,
    requiredApprovals: env?.requiredApprovals ?? 1,
    monitor: env?.monitor ?? false,
  });
  const [deleting, setDeleting] = useState(false);
  const save = useMutation({
    mutationFn: () => api(env ? `/projects/${slug}/environments/${env.id}` : `/projects/${slug}/environments`, { method: env ? 'PUT' : 'POST', body: v }),
    onSuccess: () => {
      toast('Ortam kaydedildi');
      void qc.invalidateQueries({ queryKey: ['environments'] });
      onDone();
    },
  });
  const del = useMutation({
    mutationFn: () => api(`/projects/${slug}/environments/${env!.id}?confirm=${encodeURIComponent(env!.slug)}`, { method: 'DELETE' }),
    onSuccess: () => {
      toast('Ortam silindi');
      void qc.invalidateQueries({ queryKey: ['environments'] });
      onDone();
    },
    onError: (e) => toast(errorMessage(e), 'bad'),
  });
  const set = <K extends keyof typeof v>(k: K, val: (typeof v)[K]) => setV((x) => ({ ...x, [k]: val }));
  return (
    <>
      <div className="grid g2">
        <Field label="Ad" id="env-name">
          <input
            id="env-name"
            className="in"
            value={v.name}
            onChange={(e) => {
              set('name', e.target.value);
              if (!env) set('slug', e.target.value.toLocaleLowerCase('tr-TR').replace(/ı/g, 'i').normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''));
            }}
          />
        </Field>
        <Field label="Kısa ad" id="env-slug">
          <input id="env-slug" className="in mono" value={v.slug} onChange={(e) => set('slug', e.target.value)} />
        </Field>
        <Field label="Tür" id="env-type" hint="Production ortamı ayrı yetki ve güvenlik politikası gerektirir">
          <select id="env-type" className="in" value={v.type} onChange={(e) => set('type', e.target.value as Environment['type'])}>
            {Object.entries(ENV_TYPE).map(([k, l]) => (
              <option key={k} value={k}>
                {l}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Genel adres" id="env-url" hint="Sağlık ve smoke kontrolleri bu adrese yapılır">
          <input id="env-url" className="in mono" placeholder="https://ornek.com" value={v.url} onChange={(e) => set('url', e.target.value)} />
        </Field>
        <Field label="Sağlık yolu" id="env-hp">
          <input id="env-hp" className="in mono" value={v.healthPath} onChange={(e) => set('healthPath', e.target.value)} />
        </Field>
      </div>
      <label className="check">
        <input type="checkbox" checked={v.monitor} onChange={(e) => set('monitor', e.target.checked)} disabled={!v.url} /> 5 dakikada bir sağlık kontrolü yap, art arda 3 hata olursa olay aç
      </label>
      <label className="check">
        <input type="checkbox" checked={v.requiresApproval} onChange={(e) => set('requiresApproval', e.target.checked)} /> Deployment öncesi onay iste
      </label>
      {v.requiresApproval && (
        <Field label="Gerekli onay sayısı" id="env-ap" hint="İsteyen kişi kendi deployment'ını onaylayamaz">
          <input id="env-ap" className="in" type="number" min={1} max={5} value={v.requiredApprovals} onChange={(e) => set('requiredApprovals', Number(e.target.value))} style={{ width: 100 }} />
        </Field>
      )}
      {save.error && <div className="badbox">{errorMessage(save.error)}</div>}
      <div className="row" style={{ marginTop: 14 }}>
        <button className="btn pri" disabled={!v.name.trim() || !v.slug || save.isPending} onClick={() => save.mutate()}>
          Kaydet
        </button>
        {env && (
          <button className="btn danger" onClick={() => setDeleting(true)}>
            Ortamı sil
          </button>
        )}
      </div>
      {deleting && env && (
        <ConfirmDialog
          title="Ortamı sil"
          message="Ortam, yayın hedefi ve kayıtlı bağlantı bilgileri silinir. Deployment geçmişi denetim kaydında korunur. Sunucudaki dosyalara dokunulmaz."
          confirmText={env.slug}
          actionLabel="Sil"
          busy={del.isPending}
          onConfirm={() => del.mutate()}
          onClose={() => setDeleting(false)}
        />
      )}
    </>
  );
}

function TargetForm({ slug, env }: { slug: string; env: Environment }) {
  const qc = useQueryClient();
  const toast = useToast();
  const t = env.target;
  const [v, setV] = useState({
    adapter: (t?.adapter ?? 'sftp') as 'local' | 'sftp' | 'ftp' | 'ssh',
    host: t?.host ?? '',
    port: t?.port ? String(t.port) : '',
    username: t?.username ?? '',
    remotePath: t?.remotePath ?? '',
    credential: '',
    credentialType: (t?.configuration.credentialType ?? 'password') as 'password' | 'private_key',
    secure: t?.configuration.secure ?? true,
    keepReleases: t?.configuration.keepReleases ?? 3,
    postDeployCommand: t?.configuration.postDeployCommand ?? '',
  });
  const set = <K extends keyof typeof v>(k: K, val: (typeof v)[K]) => setV((x) => ({ ...x, [k]: val }));
  const save = useMutation({
    mutationFn: () =>
      api(`/projects/${slug}/environments/${env.id}/target`, {
        method: 'PUT',
        body: {
          adapter: v.adapter,
          host: v.host,
          port: v.port ? Number(v.port) : undefined,
          username: v.username,
          remotePath: v.remotePath,
          credential: v.credential || undefined,
          credentialType: v.credentialType,
          secure: v.secure,
          keepReleases: v.keepReleases,
          postDeployCommand: v.adapter === 'ssh' && v.postDeployCommand ? v.postDeployCommand : undefined,
        },
      }),
    onSuccess: () => {
      toast('Yayın hedefi kaydedildi');
      set('credential', '');
      void qc.invalidateQueries({ queryKey: ['environments'] });
    },
  });
  const test = useMutation({
    mutationFn: () => api(`/projects/${slug}/environments/${env.id}/target/test`, { method: 'POST' }),
    onSuccess: () => toast('Bağlantı testi başladı; sonuç bildirim olarak gelecek'),
    onError: (e) => toast(errorMessage(e), 'bad'),
  });
  const remote = v.adapter !== 'local';
  return (
    <>
      <Field label="Yöntem" id="tg-ad">
        <Segmented
          value={v.adapter}
          onChange={(a) => setV((x) => ({ ...x, adapter: a, port: '', secure: a === 'ftp' ? true : x.secure }))}
          items={[
            ['sftp', 'SFTP'],
            ['ssh', 'SSH (SFTP + komut)'],
            ['ftp', 'FTP / FTPS'],
            ['local', 'Sunucu klasörü'],
          ]}
        />
      </Field>
      {v.adapter === 'local' && <p className="small muted">Hub sunucusundaki bir klasöre yayınlar. Klasör, yöneticinin DEPLOY_LOCAL_ROOTS ile izin verdiği kökler altında olmalı.</p>}
      {v.adapter === 'ftp' && !v.secure && <div className="warnbox small">Şifrelenmemiş FTP; parola ağda açık gider. Yalnızca eski barındırma için kullanın.</div>}
      {remote && (
        <div className="grid g2">
          <Field label="Sunucu" id="tg-host">
            <input id="tg-host" className="in mono" value={v.host} onChange={(e) => set('host', e.target.value)} placeholder="ftp.ornek.com" />
          </Field>
          <Field label="Port" id="tg-port" hint={v.adapter === 'ftp' ? 'Varsayılan 21' : 'Varsayılan 22'}>
            <input id="tg-port" className="in mono" value={v.port} onChange={(e) => set('port', e.target.value.replace(/\D/g, ''))} />
          </Field>
          <Field label="Kullanıcı" id="tg-user">
            <input id="tg-user" className="in mono" value={v.username} onChange={(e) => set('username', e.target.value)} autoComplete="off" />
          </Field>
          {v.adapter !== 'ftp' && (
            <Field label="Kimlik doğrulama" id="tg-ct">
              <select id="tg-ct" className="in" value={v.credentialType} onChange={(e) => set('credentialType', e.target.value as 'password' | 'private_key')}>
                <option value="password">Parola</option>
                <option value="private_key">SSH özel anahtarı</option>
              </select>
            </Field>
          )}
        </div>
      )}
      {remote && (
        <Field label={v.credentialType === 'private_key' && v.adapter !== 'ftp' ? 'Özel anahtar' : 'Parola'} id="tg-cred" hint={t?.hasCredential ? 'Kayıtlı. Değiştirmek için yenisini girin; boş bırakılırsa korunur.' : 'Şifrelenerek saklanır ve bir daha gösterilmez.'}>
          {v.credentialType === 'private_key' && v.adapter !== 'ftp' ? (
            <textarea id="tg-cred" className="in mono" value={v.credential} onChange={(e) => set('credential', e.target.value)} placeholder="-----BEGIN OPENSSH PRIVATE KEY-----" />
          ) : (
            <input id="tg-cred" className="in" type="password" value={v.credential} onChange={(e) => set('credential', e.target.value)} autoComplete="new-password" />
          )}
        </Field>
      )}
      <Field label={remote ? 'Uzak klasör' : 'Klasör'} id="tg-path" hint="Sürümler bu klasörün yanında hazırlanır, sonra atomik olarak yer değiştirir">
        <input id="tg-path" className="in mono" value={v.remotePath} onChange={(e) => set('remotePath', e.target.value)} placeholder={remote ? '/var/www/site' : 'C:/sites/proje'} />
      </Field>
      <div className="grid g2">
        <Field label="Saklanacak eski sürüm" id="tg-keep" hint="Geri alma için">
          <input id="tg-keep" className="in" type="number" min={1} max={20} value={v.keepReleases} onChange={(e) => set('keepReleases', Number(e.target.value))} />
        </Field>
        {v.adapter === 'ftp' && (
          <div className="field">
            <label>Şifreleme</label>
            <label className="check">
              <input type="checkbox" checked={v.secure} onChange={(e) => set('secure', e.target.checked)} /> FTPS (TLS)
            </label>
          </div>
        )}
      </div>
      {v.adapter === 'ssh' && (
        <Field label="Yayın sonrası komut" id="tg-post" hint="Yeni sürüm klasöründe çalışır, ör. npm ci --omit=dev && pm2 reload app">
          <input id="tg-post" className="in mono" value={v.postDeployCommand} onChange={(e) => set('postDeployCommand', e.target.value)} />
        </Field>
      )}
      {save.error && <div className="badbox">{errorMessage(save.error)}</div>}
      <div className="row" style={{ marginTop: 12 }}>
        <button className="btn pri" disabled={!v.remotePath.trim() || (remote && !v.host.trim()) || save.isPending} onClick={() => save.mutate()}>
          Kaydet
        </button>
        {t && (
          <button className="btn" onClick={() => test.mutate()} disabled={test.isPending}>
            Bağlantıyı test et
          </button>
        )}
      </div>
    </>
  );
}

function HealthHistory({ slug, env }: { slug: string; env: Environment }) {
  const q = useQuery({ queryKey: ['healthChecks', env.id], queryFn: () => api<{ id: string; ok: boolean; httpStatus: number | null; latencyMs: number | null; error: string | null; checkedAt: string }[]>(`/projects/${slug}/environments/${env.id}/health-checks`) });
  return (
    <Async q={q}>
      {(rows) =>
        rows.length ? (
          <>
            <div style={{ display: 'flex', gap: 2, alignItems: 'flex-end', height: 60, marginBottom: 12 }} aria-label="Son kontroller">
              {[...rows].reverse().slice(-96).map((r) => (
                <div key={r.id} title={`${dateTime(r.checkedAt)} · ${r.ok ? `${r.latencyMs} ms` : (r.error ?? r.httpStatus)}`} style={{ flex: 1, minWidth: 2, height: r.ok ? `${Math.min(100, 20 + (r.latencyMs ?? 0) / 20)}%` : '100%', background: r.ok ? 'var(--ok)' : 'var(--bad)', borderRadius: 1, opacity: r.ok ? 0.7 : 1 }} />
              ))}
            </div>
            <div className="tbl">
              <table>
                <tbody>
                  {rows.slice(0, 30).map((r) => (
                    <tr key={r.id}>
                      <td className="small">{dateTime(r.checkedAt)}</td>
                      <td>{r.ok ? <StatusBadge status="healthy" /> : <StatusBadge status="down" />}</td>
                      <td className="mono small">{r.httpStatus ?? '—'}</td>
                      <td className="mono small">{r.latencyMs !== null ? `${r.latencyMs} ms` : '—'}</td>
                      <td className="small muted">{r.error}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        ) : (
          <p className="small muted">{env.monitor ? 'Henüz kontrol yapılmadı.' : 'İzleme kapalı. Genel sekmesinden açabilirsiniz.'}</p>
        )
      }
    </Async>
  );
}

function DeployDrawer({ slug, env, canOverride, onClose }: { slug: string; env: Environment; canOverride: boolean; onClose: () => void }) {
  const router = useRouter();
  const qc = useQueryClient();
  const versions = useQuery({ queryKey: ['versions', slug], queryFn: () => api<Version[]>(`/projects/${slug}/versions`) });
  const [versionId, setVersionId] = useState('');
  const [runMigrations, setRunMigrations] = useState(true);
  const [backup, setBackup] = useState(true);
  const [override, setOverride] = useState(false);
  const [reason, setReason] = useState('');
  const selected = versions.data?.find((v) => v.id === (versionId || versions.data?.[0]?.id));
  const deploy = useMutation({
    mutationFn: () =>
      api<Deployment>(`/projects/${slug}/deployments`, {
        method: 'POST',
        body: { environmentId: env.id, versionId: selected!.id, runMigrations, backup, overrideSecurityPolicy: override, overrideReason: override ? reason : undefined },
      }),
    onSuccess: (d) => {
      void qc.invalidateQueries({ queryKey: ['deployments'] });
      router.push(`/projects/${slug}/deployments/${d.id}`);
    },
  });
  const policyBlocked = deploy.error instanceof ApiError && deploy.error.code === 'POLICY_DENIED';
  const risky = selected?.migrations.some((m) => m.risk === 'high');
  return (
    <Drawer
      title={`${env.name} ortamına deploy`}
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            Vazgeç
          </button>
          <button className="btn pri" disabled={!selected || deploy.isPending || (override && reason.trim().length < 10)} onClick={() => deploy.mutate()}>
            {deploy.isPending && <span className="spinner" />} {env.requiresApproval ? 'Onaya gönder' : 'Deploy et'}
          </button>
        </>
      }
    >
      <Async q={versions}>
        {(list) =>
          list.length ? (
            <>
              <Field label="Versiyon" id="dp-ver">
                <select id="dp-ver" className="in" value={selected?.id ?? ''} onChange={(e) => setVersionId(e.target.value)}>
                  {list.map((v) => (
                    <option key={v.id} value={v.id}>
                      v{v.version} · build #{v.buildNumber} · {shortSha(v.commitSha)}
                      {v.liveIn.length ? ` · yayında: ${v.liveIn.join(', ')}` : ''}
                    </option>
                  ))}
                </select>
              </Field>
              {selected && (
                <div className="panel" style={{ padding: 12, marginBottom: 12 }}>
                  <div className="small muted">Sürüm notları</div>
                  <div style={{ whiteSpace: 'pre-wrap', fontSize: 13 }}>{selected.releaseNotes || '—'}</div>
                  {selected.migrations.length > 0 && (
                    <>
                      <div className="small muted" style={{ marginTop: 8 }}>
                        Veritabanı değişiklikleri
                      </div>
                      {selected.migrations.map((m) => (
                        <div key={m.path} className="small">
                          <StatusBadge status={m.risk} /> <span className="mono">{m.name}</span> {m.operations.join(', ')}
                        </div>
                      ))}
                    </>
                  )}
                </div>
              )}
              {risky && <div className="warnbox small" style={{ marginBottom: 12 }}>Yüksek riskli veritabanı değişikliği var (tablo/kolon silme vb.). Yedek almadan devam etmeyin.</div>}
              <label className="check">
                <input type="checkbox" checked={backup} onChange={(e) => setBackup(e.target.checked)} /> Öncesinde veritabanı yedeği al (bağlantı tanımlıysa)
              </label>
              <label className="check">
                <input type="checkbox" checked={runMigrations} onChange={(e) => setRunMigrations(e.target.checked)} /> Migration&apos;ları çalıştır (manifestte komut tanımlıysa)
              </label>
              <p className="small muted">
                Adımlar: policy → artifact doğrulama → paket → yedek → migration → yükleme ve atomik geçiş → sağlık ve smoke testi. Sağlık kontrolü başarısız olursa önceki sürüme otomatik dönülür.
                {env.requiresApproval && ` Bu ortam ${env.requiredApprovals} kişi onayı gerektirir.`}
              </p>
              {(policyBlocked || override) && (
                <div className="badbox" style={{ marginTop: 10 }}>
                  {policyBlocked && <div style={{ marginBottom: 8 }}>{errorMessage(deploy.error)}</div>}
                  {canOverride ? (
                    <>
                      <label className="check">
                        <input type="checkbox" checked={override} onChange={(e) => setOverride(e.target.checked)} /> Güvenlik politikası istisnası ver (denetim kaydına yazılır)
                      </label>
                      {override && <textarea className="in" placeholder="Gerekçe (en az 10 karakter)" value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500} />}
                    </>
                  ) : (
                    <div className="small">
                      İstisna için güvenlik yöneticisi gerekir. <Link href={`/projects/${slug}/security`}>Güvenlik bulgularını inceleyin</Link>.
                    </div>
                  )}
                </div>
              )}
              {deploy.error && !policyBlocked && <div className="badbox" style={{ marginTop: 10 }}>{errorMessage(deploy.error)}</div>}
            </>
          ) : (
            <Empty title="Versiyon yok" action={<Link className="btn pri" href={`/projects/${slug}/versions?new=1`}>Versiyon oluştur</Link>}>
              Deploy edilecek bir versiyon yok. Başarılı bir build&apos;den versiyon oluşturun.
            </Empty>
          )
        }
      </Async>
    </Drawer>
  );
}
