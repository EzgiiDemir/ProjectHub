'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import dynamic from 'next/dynamic';
import { useRouter, useSearchParams } from 'next/navigation';
import { useEffect, useState } from 'react';
import type { DetectionResult, Manifest } from '@projecthub/contracts';
import { api, errorMessage } from '@/lib/api';
import { ago } from '@/lib/format';
import { useDirectory, useMe, useProject, useProjectSlug } from '@/lib/hooks';
import type { Member, ProjectDetail, Role } from '@/lib/types';
import { Async, Avatar, ConfirmDialog, Field, KeyValue, Loading, Panel, Tabs } from '@/components/ui';
import { useToast } from '@/components/toast';

const CodeEditor = dynamic(() => import('@/components/code-editor').then((m) => m.CodeEditor), { ssr: false, loading: () => <Loading /> });

type Tab = 'general' | 'members' | 'manifest' | 'danger';

export default function SettingsPage() {
  const slug = useProjectSlug();
  const params = useSearchParams();
  const router = useRouter();
  const project = useProject();
  const tab = (params.get('tab') as Tab) ?? 'general';
  const p = project.data;
  if (!p) return <Loading />;
  const can = (perm: Parameters<typeof p.permissions.includes>[0]) => p.permissions.includes(perm);
  return (
    <>
      <h2 style={{ margin: '0 0 6px' }}>Ayarlar ve üyeler</h2>
      <Tabs
        value={tab}
        onChange={(t) => router.replace(`/projects/${slug}/settings?tab=${t}`)}
        items={[
          ['general', 'Genel'],
          ['members', 'Üyeler'],
          ['manifest', 'projecthub.yml'],
          ['danger', 'Arşiv ve kaynak'],
        ]}
      />
      {tab === 'general' && <General project={p} canEdit={can('project.update') && p.status !== 'archived'} />}
      {tab === 'members' && <Members slug={slug} canManage={can('project.members.manage')} />}
      {tab === 'manifest' && <ManifestEditor slug={slug} canEdit={can('project.update') && p.status !== 'archived'} />}
      {tab === 'danger' && <Danger project={p} canArchive={can('project.archive')} canSync={can('repository.push')} />}
    </>
  );
}

function General({ project: p, canEdit }: { project: ProjectDetail; canEdit: boolean }) {
  const qc = useQueryClient();
  const toast = useToast();
  const teams = useQuery({ queryKey: ['teams'], queryFn: () => api<{ id: string; name: string }[]>('/admin/teams') });
  const [v, setV] = useState({
    name: p.name,
    description: p.description,
    customerName: p.customerName,
    color: p.color,
    teamId: p.teamId ?? '',
    status: p.status === 'archived' ? 'active' : p.status,
    executionTrust: p.settings.executionTrust ?? 'trusted',
  });
  const set = <K extends keyof typeof v>(k: K, val: (typeof v)[K]) => setV((x) => ({ ...x, [k]: val }));
  const save = useMutation({
    mutationFn: () => api(`/projects/${p.slug}`, { method: 'PATCH', body: { ...v, teamId: v.teamId || null } }),
    onSuccess: () => {
      toast('Proje güncellendi');
      void qc.invalidateQueries({ queryKey: ['project'] });
      void qc.invalidateQueries({ queryKey: ['projects'] });
    },
  });
  return (
    <div className="grid split" style={{ alignItems: 'start' }}>
      <Panel>
        <fieldset disabled={!canEdit} style={{ border: 0, padding: 0, margin: 0 }}>
          <div className="grid g2">
            <Field label="Proje adı" id="pg-name">
              <input id="pg-name" className="in" value={v.name} onChange={(e) => set('name', e.target.value)} maxLength={150} />
            </Field>
            <Field label="Kullanıcı" id="pg-cust">
              <input id="pg-cust" className="in" value={v.customerName} onChange={(e) => set('customerName', e.target.value)} maxLength={150} />
            </Field>
          </div>
          <Field label="Açıklama" id="pg-desc">
            <textarea id="pg-desc" className="in" value={v.description} onChange={(e) => set('description', e.target.value)} maxLength={2000} />
          </Field>
          <div className="grid g3">
            <Field label="Durum" id="pg-status">
              <select id="pg-status" className="in" value={v.status} onChange={(e) => set('status', e.target.value as typeof v.status)}>
                <option value="active">Aktif</option>
                <option value="maintenance">Bakımda</option>
                <option value="paused">Durduruldu</option>
              </select>
            </Field>
            <Field label="Ekip" id="pg-team">
              <select id="pg-team" className="in" value={v.teamId} onChange={(e) => set('teamId', e.target.value)}>
                <option value="">—</option>
                {teams.data?.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Renk" id="pg-color">
              <input id="pg-color" type="color" className="in" style={{ height: 36, padding: 2 }} value={v.color} onChange={(e) => set('color', e.target.value)} />
            </Field>
          </div>
          <Field label="Kod çalıştırma güveni" id="pg-trust">
            <select id="pg-trust" className="in" value={v.executionTrust} onChange={(e) => set('executionTrust', e.target.value as typeof v.executionTrust)}>
              <option value="untrusted">Güvenilmeyen — build komutlarını engelle</option>
              <option value="trusted">Güvenilir — worker üzerinde build/test çalıştır</option>
            </select>
          </Field>
          {v.executionTrust === 'trusted' && (
            <div className="warnbox" style={{ marginBottom: 14 }}>
              Yalnızca kaynağını ve build betiklerini incelediğiniz projelerde etkinleştirin. Mevcut worker süreç yalıtımı, kötü niyetli kod için güvenlik sınırı değildir.
            </div>
          )}
          {save.error && <div className="badbox">{errorMessage(save.error)}</div>}
          {canEdit && (
            <button className="btn pri" onClick={() => save.mutate()} disabled={!v.name.trim() || save.isPending}>
              Kaydet
            </button>
          )}
        </fieldset>
      </Panel>
      <Panel title="Kimlik">
        <KeyValue
          items={[
            ['Kısa ad', <span key="s" className="mono">{p.slug}</span>],
            ['Varsayılan branch', <span key="b" className="tag">{p.defaultBranch}</span>],
            ['Kaynak', p.sourceLabel],
            ['Oluşturulma', ago(p.createdAt)],
            ['Sahip', p.owner?.displayName ?? '—'],
          ]}
        />
        <p className="small muted" style={{ marginBottom: 0 }}>Kısa ad; Git adresi, ön izleme alan adları ve bağlantılar için kullanıldığından değiştirilemez.</p>
      </Panel>
    </div>
  );
}

function Members({ slug, canManage }: { slug: string; canManage: boolean }) {
  const qc = useQueryClient();
  const toast = useToast();
  const me = useMe().data;
  const directory = useDirectory();
  const roles = useQuery({ queryKey: ['roles'], queryFn: () => api<Role[]>('/admin/roles') });
  const q = useQuery({ queryKey: ['members', slug], queryFn: () => api<Member[]>(`/projects/${slug}/members`) });
  const [userId, setUserId] = useState('');
  const [roleId, setRoleId] = useState('');
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['members', slug] });
    void qc.invalidateQueries({ queryKey: ['project', slug] });
  };
  const add = useMutation({
    mutationFn: (body: { userId: string; roleId: string | null }) => api(`/projects/${slug}/members`, { method: 'POST', body }),
    onSuccess: () => {
      toast('Üye kaydedildi');
      setUserId('');
      refresh();
    },
    onError: (e) => toast(errorMessage(e), 'bad'),
  });
  const remove = useMutation({
    mutationFn: (id: string) => api(`/projects/${slug}/members/${id}`, { method: 'DELETE' }),
    onSuccess: () => (toast('Üye çıkarıldı'), refresh()),
    onError: (e) => toast(errorMessage(e), 'bad'),
  });
  const projectRoles = (roles.data ?? []).filter((r) => r.key !== 'super_admin');
  return (
    <>
      <p className="sub" style={{ marginTop: 0 }}>Proje rolü, kullanıcının bu projedeki yetkilerini belirler. Rol seçilmezse organizasyondaki rolü geçerlidir.</p>
      {canManage && (
        <Panel className="mt">
          <div className="row" style={{ alignItems: 'flex-end' }}>
            <Field label="Kullanıcı" id="pm-user">
              <select id="pm-user" className="in" value={userId} onChange={(e) => setUserId(e.target.value)} style={{ minWidth: 240 }}>
                <option value="">Seçin</option>
                {directory.data
                  ?.filter((u) => !q.data?.some((m) => m.userId === u.id))
                  .map((u) => (
                    <option key={u.id} value={u.id}>
                      {u.displayName} · {u.email}
                    </option>
                  ))}
              </select>
            </Field>
            <Field label="Proje rolü" id="pm-role">
              <select id="pm-role" className="in" value={roleId} onChange={(e) => setRoleId(e.target.value)}>
                <option value="">Organizasyon rolü</option>
                {projectRoles.map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.name}
                  </option>
                ))}
              </select>
            </Field>
            <div className="field">
              <button className="btn pri" disabled={!userId || add.isPending} onClick={() => add.mutate({ userId, roleId: roleId || null })}>
                Ekle
              </button>
            </div>
          </div>
        </Panel>
      )}
      <Async q={q} rows={3}>
        {(rows) => (
          <Panel flush className="mt">
            <div className="tbl">
              <table>
                <tbody>
                  {rows.map((m) => (
                    <tr key={m.userId}>
                      <td style={{ width: 40 }}>
                        <Avatar name={m.displayName} color={m.avatarColor} />
                      </td>
                      <td>
                        <b>{m.displayName}</b> <span className="small muted">{m.title}</span>
                        <div className="small muted">{m.email}</div>
                      </td>
                      <td>
                        {canManage ? (
                          <select className="in" style={{ width: 'auto' }} value={m.roleId ?? ''} onChange={(e) => add.mutate({ userId: m.userId, roleId: e.target.value || null })} aria-label="Rol">
                            <option value="">Organizasyon rolü</option>
                            {projectRoles.map((r) => (
                              <option key={r.id} value={r.id}>
                                {r.name}
                              </option>
                            ))}
                          </select>
                        ) : (
                          <span className="small">{m.roleName ?? 'Organizasyon rolü'}</span>
                        )}
                      </td>
                      <td className="small muted">{ago(m.addedAt)}</td>
                      <td style={{ textAlign: 'right' }}>
                        {canManage && m.userId !== me?.user.id && (
                          <button className="btn sm ghost" onClick={() => remove.mutate(m.userId)} disabled={remove.isPending}>
                            Çıkar
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Panel>
        )}
      </Async>
    </>
  );
}

interface ManifestInfo {
  source: string;
  manifest: Manifest | null;
  yaml: string;
  inRepository: boolean;
  repositoryError: string | null;
  detection: DetectionResult | null;
  storedVersion: number | null;
}

function ManifestEditor({ slug, canEdit }: { slug: string; canEdit: boolean }) {
  const qc = useQueryClient();
  const toast = useToast();
  const q = useQuery({ queryKey: ['manifest', slug], queryFn: () => api<ManifestInfo>(`/projects/${slug}/manifest`) });
  const [yaml, setYaml] = useState('');
  useEffect(() => {
    if (q.data) setYaml(q.data.yaml);
  }, [q.data]);
  const save = useMutation({
    mutationFn: () => api<ManifestInfo>(`/projects/${slug}/manifest`, { method: 'PUT', body: { yaml, commit: true } }),
    onSuccess: (m) => {
      qc.setQueryData(['manifest', slug], m);
      void qc.invalidateQueries({ queryKey: ['project', slug] });
      toast('projecthub.yml kaydedildi ve repository’ye commit edildi');
    },
  });
  const detect = useMutation({
    mutationFn: () => api(`/projects/${slug}/detect`, { method: 'POST' }),
    onSuccess: () => {
      toast('Proje yeniden analiz ediliyor');
      setTimeout(() => void qc.invalidateQueries({ queryKey: ['manifest', slug] }), 4000);
    },
    onError: (e) => toast(errorMessage(e), 'bad'),
  });
  return (
    <Async q={q}>
      {(m) => (
        <div className="grid split" style={{ alignItems: 'start' }}>
          <div>
            {m.repositoryError && <div className="badbox" style={{ marginBottom: 10 }}>Repository&apos;deki projecthub.yml geçersiz: {m.repositoryError}</div>}
            <div className="panel flush" style={{ height: 560, overflow: 'hidden' }}>
              <div className="ed-body" style={{ height: '100%' }}>
                <CodeEditor value={yaml} language="yaml" readOnly={!canEdit} onChange={setYaml} />
              </div>
            </div>
            {save.error && <div className="badbox" style={{ marginTop: 10, whiteSpace: 'pre-wrap' }}>{errorMessage(save.error)}</div>}
            {canEdit && (
              <div className="row" style={{ marginTop: 10 }}>
                <button className="btn pri" disabled={yaml === m.yaml || save.isPending} onClick={() => save.mutate()}>
                  Doğrula, kaydet ve commit et
                </button>
                <button className="btn" onClick={() => setYaml(m.yaml)} disabled={yaml === m.yaml}>
                  Geri al
                </button>
              </div>
            )}
          </div>
          <div className="grid" style={{ gap: 14 }}>
            <Panel title="Durum">
              <KeyValue
                items={[
                  ['Kaynak', m.inRepository ? 'Repository’deki projecthub.yml' : 'Otomatik tespit (repository’de dosya yok)'],
                  ['Kayıtlı sürüm', m.storedVersion ? `#${m.storedVersion}` : '—'],
                ]}
              />
              <p className="small muted" style={{ marginBottom: 0 }}>
                Manifest; kurulum, build, test, ön izleme, migration ve deployment davranışını belirler. Kaydedince varsayılan branch&apos;e commit edilir; bir sonraki build&apos;den itibaren geçerli olur.
              </p>
            </Panel>
            {m.detection && (
              <Panel title="Otomatik tespit" actions={canEdit && <button className="btn sm" onClick={() => detect.mutate()} disabled={detect.isPending}>Yeniden analiz et</button>}>
                <KeyValue
                  items={[
                    ['Tür', m.detection.projectType],
                    ['Çalışma ortamı', `${m.detection.runtime.type}${m.detection.runtime.version ? ` ${m.detection.runtime.version}` : ''}`],
                    ['Teknolojiler', m.detection.technologies.join(', ') || '—'],
                    ['Kurulum', <span key="i" className="mono small">{m.detection.installCommand ?? '—'}</span>],
                    ['Build', <span key="b" className="mono small">{m.detection.buildCommand ?? '—'}</span>],
                    ['Test', <span key="t" className="mono small">{m.detection.testCommand ?? '—'}</span>],
                    ['Başlatma', <span key="s" className="mono small">{m.detection.startCommand ?? '—'}</span>],
                    ['Ön izleme', m.detection.previewMode === 'process' ? `Uygulama (port ${m.detection.port ?? '—'})` : 'Statik'],
                    ['Veritabanı', m.detection.database === 'none' ? 'yok' : m.detection.database],
                  ]}
                />
                {!!m.detection.warnings.length && (
                  <div className="warnbox small" style={{ marginTop: 10 }}>
                    {m.detection.warnings.map((w) => (
                      <div key={w}>• {w}</div>
                    ))}
                  </div>
                )}
              </Panel>
            )}
          </div>
        </div>
      )}
    </Async>
  );
}

function Danger({ project: p, canArchive, canSync }: { project: ProjectDetail; canArchive: boolean; canSync: boolean }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [archiving, setArchiving] = useState(false);
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['project'] });
    void qc.invalidateQueries({ queryKey: ['projects'] });
  };
  const archive = useMutation({
    mutationFn: () => api(`/projects/${p.slug}/archive`, { method: 'POST', body: { confirmSlug: p.slug } }),
    onSuccess: () => (toast('Proje arşivlendi'), setArchiving(false), refresh()),
    onError: (e) => toast(errorMessage(e), 'bad'),
  });
  const unarchive = useMutation({ mutationFn: () => api(`/projects/${p.slug}/unarchive`, { method: 'POST' }), onSuccess: () => (toast('Proje arşivden çıkarıldı'), refresh()), onError: (e) => toast(errorMessage(e), 'bad') });
  const sync = useMutation({ mutationFn: () => api(`/projects/${p.slug}/sync`, { method: 'POST' }), onSuccess: () => toast('Kaynak repository’den güncelleniyor'), onError: (e) => toast(errorMessage(e), 'bad') });
  return (
    <div className="grid g2" style={{ alignItems: 'start' }}>
      {p.repository?.upstreamUrl && (
        <Panel title="Harici kaynak">
          <p className="small" style={{ marginTop: 0 }}>
            Proje <span className="mono">{p.repository.upstreamUrl}</span> adresinden içe aktarıldı. Güncelleme, harici repository&apos;deki branch&apos;leri getirir; Project Hub&apos;daki değişiklikleri ezmez (ileri sarılamayan branch&apos;ler atlanır).
          </p>
          {canSync && p.status !== 'archived' && (
            <button className="btn" onClick={() => sync.mutate()} disabled={sync.isPending}>
              Kaynaktan güncelle
            </button>
          )}
        </Panel>
      )}
      <Panel title={p.status === 'archived' ? 'Arşivden çıkar' : 'Projeyi arşivle'}>
        {p.status === 'archived' ? (
          <>
            <p className="small" style={{ marginTop: 0 }}>Arşivden çıkarılan proje yeniden build, ön izleme ve deployment alabilir.</p>
            {canArchive && (
              <button className="btn" onClick={() => unarchive.mutate()} disabled={unarchive.isPending}>
                Arşivden çıkar
              </button>
            )}
          </>
        ) : (
          <>
            <p className="small" style={{ marginTop: 0 }}>
              Arşivlenen proje silinmez: kod, sürümler, dokümanlar ve denetim kayıtları korunur. Çalışan ön izlemeler durdurulur, kullanıcı linkleri kapatılır; build ve deployment kapanır.
            </p>
            {canArchive && (
              <button className="btn danger" onClick={() => setArchiving(true)}>
                Arşivle
              </button>
            )}
          </>
        )}
      </Panel>
      {archiving && (
        <ConfirmDialog
          title="Projeyi arşivle"
          message="Çalışan ön izlemeler durdurulur ve aktif kullanıcı linkleri kapatılır."
          confirmText={p.slug}
          actionLabel="Arşivle"
          busy={archive.isPending}
          onConfirm={() => archive.mutate()}
          onClose={() => setArchiving(false)}
        />
      )}
    </div>
  );
}
