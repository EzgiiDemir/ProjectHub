'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Eye, EyeOff, Plus, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { api, errorMessage } from '@/lib/api';
import { ago } from '@/lib/format';
import { useProject, useProjectSlug } from '@/lib/hooks';
import type { Environment } from '@/lib/types';
import { Async, ConfirmDialog, CopyButton, Drawer, Empty, Field, Panel } from '@/components/ui';
import { useToast } from '@/components/toast';

interface SecretMeta {
  id: string;
  name: string;
  kind: 'env' | 'credential' | 'api_key' | 'ssh_key';
  scope: 'build' | 'runtime' | 'deploy' | 'all';
  environmentId: string | null;
  environmentName: string;
  createdByName: string | null;
  updatedAt: string;
  lastAccessedAt: string | null;
}

const KIND: Record<SecretMeta['kind'], string> = { env: 'Ortam değişkeni', credential: 'Kimlik bilgisi', api_key: 'API anahtarı', ssh_key: 'SSH anahtarı' };
const SCOPE: Record<SecretMeta['scope'], [string, string]> = {
  build: ['Build', 'Build komutlarına ortam değişkeni olarak verilir'],
  runtime: ['Çalışma', 'Ön izleme uygulama sürecine verilir'],
  deploy: ['Deployment', 'Migration ve sunucu komutlarına verilir'],
  all: ['Tümü', 'Build, ön izleme ve deployment'],
};

/** Encrypted project secrets (spec §95–97). Values are write-only except for an audited reveal. */
export default function SecretsPage() {
  const slug = useProjectSlug();
  const qc = useQueryClient();
  const toast = useToast();
  const project = useProject().data;
  const [editing, setEditing] = useState<SecretMeta | 'new' | null>(null);
  const [revealed, setRevealed] = useState<Record<string, string>>({});
  const [deleting, setDeleting] = useState<SecretMeta | null>(null);
  const q = useQuery({ queryKey: ['secrets', slug], queryFn: () => api<SecretMeta[]>(`/projects/${slug}/secrets`) });
  const canRead = !!project?.permissions.includes('secret.read');
  const reveal = useMutation({
    mutationFn: (id: string) => api<{ value: string }>(`/secrets/${id}/reveal`, { method: 'POST' }),
    onSuccess: (r, id) => setRevealed((x) => ({ ...x, [id]: r.value })),
    onError: (e) => toast(errorMessage(e), 'bad'),
  });
  const del = useMutation({
    mutationFn: (id: string) => api(`/secrets/${id}`, { method: 'DELETE' }),
    onSuccess: () => {
      toast('Secret silindi');
      setDeleting(null);
      void qc.invalidateQueries({ queryKey: ['secrets'] });
    },
    onError: (e) => toast(errorMessage(e), 'bad'),
  });

  return (
    <>
      <div className="spread" style={{ marginBottom: 12 }}>
        <div>
          <h2 style={{ margin: 0 }}>Secret&apos;lar</h2>
          <p className="sub">AES-256-GCM ile şifrelenir; değerler listelenmez. Görüntüleme denetim kaydına yazılır. Repository&apos;ye asla .env koymayın.</p>
        </div>
        {project?.status !== 'archived' && (
          <button className="btn pri" onClick={() => setEditing('new')}>
            <Plus /> Secret ekle
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
                      <th>Ad</th>
                      <th>Tür</th>
                      <th>Kullanım</th>
                      <th>Ortam</th>
                      <th>Değer</th>
                      <th>Güncellendi</th>
                      <th />
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((s) => (
                      <tr key={s.id}>
                        <td className="mono">{s.name}</td>
                        <td className="small">{KIND[s.kind]}</td>
                        <td className="small" title={SCOPE[s.scope][1]}>
                          {SCOPE[s.scope][0]}
                        </td>
                        <td className="small">{s.environmentName}</td>
                        <td style={{ maxWidth: 260 }}>
                          {revealed[s.id] !== undefined ? (
                            <span className="row" style={{ gap: 6, flexWrap: 'nowrap' }}>
                              <code className="small ellipsis">{revealed[s.id]}</code>
                              <CopyButton text={revealed[s.id]!} />
                              <button className="icon-btn" title="Gizle" onClick={() => setRevealed(({ [s.id]: _, ...rest }) => rest)}>
                                <EyeOff size={15} />
                              </button>
                            </span>
                          ) : (
                            <span className="row" style={{ gap: 6 }}>
                              <span className="mono muted">••••••••</span>
                              {canRead && (
                                <button className="icon-btn" title="Göster (denetim kaydına yazılır)" onClick={() => reveal.mutate(s.id)}>
                                  <Eye size={15} />
                                </button>
                              )}
                            </span>
                          )}
                        </td>
                        <td className="small muted">
                          {ago(s.updatedAt)}
                          {s.createdByName && <div>{s.createdByName}</div>}
                        </td>
                        <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                          <button className="btn sm ghost" onClick={() => setEditing(s)}>
                            Değiştir
                          </button>
                          <button className="btn sm ghost" title="Sil" onClick={() => setDeleting(s)}>
                            <Trash2 size={14} />
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Panel>
          ) : (
            <Empty title="Secret yok">Veritabanı parolası, API anahtarı gibi değerleri burada saklayın; build, ön izleme ve deployment sırasında ortam değişkeni olarak verilir.</Empty>
          )
        }
      </Async>
      {editing && <SecretDrawer slug={slug} secret={editing === 'new' ? null : editing} onClose={() => setEditing(null)} />}
      {deleting && (
        <ConfirmDialog
          title="Secret'ı sil"
          message={
            <>
              <span className="mono">{deleting.name}</span> ({deleting.environmentName}) silinecek. Bu değeri kullanan build ve deployment&apos;lar artık onu almaz.
            </>
          }
          confirmText={deleting.name}
          actionLabel="Sil"
          busy={del.isPending}
          onConfirm={() => del.mutate(deleting.id)}
          onClose={() => setDeleting(null)}
        />
      )}
    </>
  );
}

function SecretDrawer({ slug, secret, onClose }: { slug: string; secret: SecretMeta | null; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const envs = useQuery({ queryKey: ['environments', slug], queryFn: () => api<Environment[]>(`/projects/${slug}/environments`) });
  const [v, setV] = useState({ name: secret?.name ?? '', value: '', kind: secret?.kind ?? 'env', scope: secret?.scope ?? 'all', environmentId: secret?.environmentId ?? '' });
  const set = <K extends keyof typeof v>(k: K, val: (typeof v)[K]) => setV((x) => ({ ...x, [k]: val }));
  const save = useMutation({
    mutationFn: () => api(`/projects/${slug}/secrets`, { method: 'POST', body: { ...v, environmentId: v.environmentId || null } }),
    onSuccess: () => {
      toast(secret ? 'Secret güncellendi' : 'Secret eklendi');
      void qc.invalidateQueries({ queryKey: ['secrets'] });
      onClose();
    },
  });
  const nameOk = /^[A-Za-z_][A-Za-z0-9_.-]*$/.test(v.name);
  return (
    <Drawer
      title={secret ? `${secret.name} değerini değiştir` : 'Secret ekle'}
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            Vazgeç
          </button>
          <button className="btn pri" disabled={!nameOk || !v.value || save.isPending} onClick={() => save.mutate()}>
            Kaydet
          </button>
        </>
      }
    >
      <Field label="Ad" id="sc-name" hint="Ortam değişkeni adı, ör. DATABASE_URL" error={v.name && !nameOk ? 'Harf veya _ ile başlamalı; harf, rakam, _ . - içerebilir' : null}>
        <input id="sc-name" className="in mono" value={v.name} onChange={(e) => set('name', e.target.value)} disabled={!!secret} />
      </Field>
      <Field label="Değer" id="sc-val" hint={secret ? 'Yeni değer eskisinin yerini alır.' : undefined}>
        <textarea id="sc-val" className="in mono" value={v.value} onChange={(e) => set('value', e.target.value)} autoComplete="off" spellCheck={false} />
      </Field>
      <div className="grid g2">
        <Field label="Tür" id="sc-kind" hint={v.kind !== 'env' ? 'Yalnızca "Ortam değişkeni" türü süreçlere otomatik verilir' : undefined}>
          <select id="sc-kind" className="in" value={v.kind} onChange={(e) => set('kind', e.target.value as SecretMeta['kind'])} disabled={!!secret}>
            {Object.entries(KIND).map(([k, l]) => (
              <option key={k} value={k}>
                {l}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Kullanım" id="sc-scope" hint={SCOPE[v.scope][1]}>
          <select id="sc-scope" className="in" value={v.scope} onChange={(e) => set('scope', e.target.value as SecretMeta['scope'])}>
            {Object.entries(SCOPE).map(([k, [l]]) => (
              <option key={k} value={k}>
                {l}
              </option>
            ))}
          </select>
        </Field>
      </div>
      <Field label="Ortam" id="sc-env" hint="Belirli bir ortama özel değer, o ortamın deployment'ında genel değerin yerine geçer">
        <select id="sc-env" className="in" value={v.environmentId} onChange={(e) => set('environmentId', e.target.value)} disabled={!!secret}>
          <option value="">Tüm ortamlar</option>
          {envs.data?.map((e) => (
            <option key={e.id} value={e.id}>
              {e.name}
            </option>
          ))}
        </select>
      </Field>
      {save.error && <div className="badbox">{errorMessage(save.error)}</div>}
    </Drawer>
  );
}
