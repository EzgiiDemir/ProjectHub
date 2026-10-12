'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ExternalLink, Plug } from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';
import { integrationEnvName, type IntegrationProviderInfo } from '@projecthub/contracts';
import { api, errorMessage } from '@/lib/api';
import { ago } from '@/lib/format';
import { useProjectSlug } from '@/lib/hooks';
import { Async, ConfirmDialog, Drawer, Empty, Field, Panel, StatusBadge } from '@/components/ui';
import { useToast } from '@/components/toast';

interface Integration {
  id: string;
  provider: string;
  providerName: string;
  name: string;
  prefix: string | null;
  enabled: boolean;
  fields: { key: string; label: string; env: string; secret: boolean; value: string | null; stored: boolean }[];
  lastCheckedAt: string | null;
  lastCheckOk: boolean | null;
  lastCheckMessage: string | null;
}

/** Third-party services this project uses; values reach builds and deployments as environment variables. */
export default function IntegrationsPage() {
  const slug = useProjectSlug();
  const qc = useQueryClient();
  const toast = useToast();
  const catalog = useQuery({ queryKey: ['integration-catalog'], queryFn: () => api<IntegrationProviderInfo[]>('/integrations/catalog'), staleTime: Infinity });
  const q = useQuery({ queryKey: ['integrations', slug], queryFn: () => api<{ items: Integration[]; canManage: boolean }>(`/projects/${slug}/integrations`) });
  const [editing, setEditing] = useState<{ provider: IntegrationProviderInfo; item: Integration | null } | null>(null);
  const [removing, setRemoving] = useState<Integration | null>(null);
  const refresh = () => void qc.invalidateQueries({ queryKey: ['integrations', slug] });
  const test = useMutation({
    mutationFn: (id: string) => api<{ ok: boolean; message: string }>(`/projects/${slug}/integrations/${id}/test`, { method: 'POST' }),
    onSuccess: (r) => {
      toast(r.message, r.ok ? undefined : 'bad');
      refresh();
    },
    onError: (e) => toast(errorMessage(e), 'bad'),
  });
  const toggle = useMutation({
    mutationFn: (i: Integration) => api(`/projects/${slug}/integrations/${i.id}`, { method: 'PUT', body: { provider: i.provider, name: i.name, values: {}, enabled: !i.enabled } }),
    onSuccess: refresh,
    onError: (e) => toast(errorMessage(e), 'bad'),
  });
  const remove = useMutation({
    mutationFn: (id: string) => api(`/projects/${slug}/integrations/${id}`, { method: 'DELETE' }),
    onSuccess: () => {
      toast('Entegrasyon ve değişkenleri kaldırıldı');
      setRemoving(null);
      refresh();
    },
    onError: (e) => toast(errorMessage(e), 'bad'),
  });
  const providerOf = (id: string) => catalog.data?.find((p) => p.id === id);

  return (
    <>
      <div style={{ marginBottom: 18 }}>
        <h2 style={{ margin: 0 }}>Entegrasyonlar</h2>
        <p className="sub">
          Projenin kullandığı dış servisler. Girilen değerler şifreli saklanır ve build ile deployment&apos;lara ortam değişkeni olarak verilir (<Link href={`/projects/${slug}/secrets`}>Secret&apos;lar</Link> sayfasında da görünür).
        </p>
      </div>
      <Async q={q} rows={3}>
        {(d) => (
          <>
            {d.items.length > 0 && (
              <div className="integration-grid" style={{ marginBottom: 28 }}>
                {d.items.map((i) => (
                  <Panel key={i.id}>
                    <div className="row" style={{ gap: 10, marginBottom: 8 }}>
                      <span className="int-icon">
                        <Plug size={18} />
                      </span>
                      <div style={{ minWidth: 0, flex: 1 }}>
                        <b>{i.name}</b>
                        <div className="small muted">{i.providerName}</div>
                      </div>
                      {!i.enabled ? <StatusBadge status="paused" label="Devre dışı" /> : i.lastCheckOk === null ? <StatusBadge status="unknown" label="Test edilmedi" /> : i.lastCheckOk ? <StatusBadge status="healthy" label="Bağlı" /> : <StatusBadge status="down" label="Hata" />}
                    </div>
                    {i.lastCheckMessage && (
                      <p className="small" style={{ color: i.lastCheckOk ? 'var(--muted)' : 'var(--bad)', margin: '6px 0 10px' }}>
                        {i.lastCheckMessage} {i.lastCheckedAt && <span className="muted">· {ago(i.lastCheckedAt)}</span>}
                      </p>
                    )}
                    <div className="env-list">
                      {i.fields
                        .filter((f) => f.stored)
                        .map((f) => (
                          <div key={f.key} className="small">
                            <span className="mono">{f.env}</span>
                            <span className="muted"> = {f.secret ? '•••••• (şifreli)' : f.value}</span>
                          </div>
                        ))}
                    </div>
                    {d.canManage && (
                      <div className="row" style={{ marginTop: 14, gap: 8, flexWrap: 'wrap' }}>
                        <button className="btn sm pri" disabled={test.isPending || !i.enabled} onClick={() => test.mutate(i.id)}>
                          {test.isPending && test.variables === i.id && <span className="spinner" />} Bağlantıyı test et
                        </button>
                        <button className="btn sm" onClick={() => providerOf(i.provider) && setEditing({ provider: providerOf(i.provider)!, item: i })}>
                          Düzenle
                        </button>
                        <button className="btn sm" onClick={() => toggle.mutate(i)}>
                          {i.enabled ? 'Devre dışı bırak' : 'Etkinleştir'}
                        </button>
                        <button className="btn sm danger" onClick={() => setRemoving(i)}>
                          Kaldır
                        </button>
                      </div>
                    )}
                  </Panel>
                ))}
              </div>
            )}
            <h3 className="sect" style={{ marginTop: 0 }}>
              {d.items.length ? 'Başka bir entegrasyon ekle' : 'Entegrasyon ekleyin'}
            </h3>
            <Async q={catalog} rows={2}>
              {(cat) => (
                <div className="integration-grid">
                  {cat.map((p) => (
                    <div key={p.id} className="panel int-card">
                      <b>{p.name}</b>
                      <p className="small muted" style={{ margin: '6px 0 14px', flex: 1 }}>
                        {p.description}
                      </p>
                      <div className="row" style={{ gap: 8 }}>
                        {d.canManage && (
                          <button className="btn sm pri" onClick={() => setEditing({ provider: p, item: null })}>
                            Ekle
                          </button>
                        )}
                        <a className="btn sm ghost" href={p.docsUrl} target="_blank" rel="noreferrer">
                          Nasıl alınır <ExternalLink size={12} />
                        </a>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </Async>
            {!d.canManage && <Empty title="Görüntüleme yetkisi">Entegrasyon eklemek için Secret yönetimi yetkisi gerekir.</Empty>}
          </>
        )}
      </Async>
      {editing && <IntegrationDrawer slug={slug} provider={editing.provider} item={editing.item} onClose={() => setEditing(null)} onSaved={() => (setEditing(null), refresh())} />}
      {removing && (
        <ConfirmDialog
          title="Entegrasyonu kaldır"
          message={<>“{removing.name}” ve ürettiği ortam değişkenleri ({removing.fields.filter((f) => f.stored).map((f) => f.env).join(', ')}) silinecek. Sonraki deployment bu değerler olmadan çalışır.</>}
          actionLabel="Kaldır"
          busy={remove.isPending}
          onConfirm={() => remove.mutate(removing.id)}
          onClose={() => setRemoving(null)}
        />
      )}
    </>
  );
}

function IntegrationDrawer({ slug, provider: p, item, onClose, onSaved }: { slug: string; provider: IntegrationProviderInfo; item: Integration | null; onClose: () => void; onSaved: () => void }) {
  const toast = useToast();
  const [name, setName] = useState(item?.name ?? p.name);
  const [prefix, setPrefix] = useState(item?.prefix ?? '');
  const [values, setValues] = useState<Record<string, string>>(Object.fromEntries(p.fields.map((f) => [f.key, item?.fields.find((x) => x.key === f.key)?.value ?? ''])));
  const save = useMutation({
    mutationFn: () =>
      api(item ? `/projects/${slug}/integrations/${item.id}` : `/projects/${slug}/integrations`, {
        method: item ? 'PUT' : 'POST',
        body: { provider: p.id, name, prefix: p.prefixed ? prefix || undefined : undefined, values, enabled: item?.enabled ?? true },
      }),
    onSuccess: () => {
      toast(item ? 'Entegrasyon güncellendi' : 'Entegrasyon eklendi — şimdi bağlantıyı test edin');
      onSaved();
    },
    onError: (e) => toast(errorMessage(e), 'bad'),
  });
  return (
    <Drawer
      title={item ? `${item.name} · düzenle` : `${p.name} ekle`}
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            Vazgeç
          </button>
          <button className="btn pri" disabled={save.isPending || !name.trim()} onClick={() => save.mutate()}>
            Kaydet
          </button>
        </>
      }
    >
      <p className="small muted" style={{ marginTop: 0 }}>
        {p.description}{' '}
        <a href={p.docsUrl} target="_blank" rel="noreferrer">
          Değerler nereden alınır?
        </a>
      </p>
      <Field label="Ad" id="int-name" hint="Bu projede entegrasyonu tanımak için">
        <input id="int-name" className="in" value={name} onChange={(e) => setName(e.target.value)} maxLength={120} />
      </Field>
      {p.prefixed && (
        <Field label="Ortam değişkeni öneki" id="int-prefix" hint="Aynı türden birden fazla servis için, ör. KARGO → KARGO_BASE_URL">
          <input id="int-prefix" className="in mono" value={prefix} disabled={!!item} onChange={(e) => setPrefix(e.target.value.toUpperCase().replace(/[^A-Z0-9_]/g, ''))} maxLength={31} />
        </Field>
      )}
      {p.fields.map((f) => {
        const stored = item?.fields.find((x) => x.key === f.key)?.stored;
        return (
          <Field
            key={f.key}
            id={`int-${f.key}`}
            label={`${f.label}${f.required ? '' : ' (isteğe bağlı)'}`}
            hint={
              <>
                <span className="mono">{integrationEnvName(f, prefix || 'ONEK')}</span>
                {f.help && <> · {f.help}</>}
                {f.secret && stored && <> · Kayıtlı; boş bırakılırsa korunur</>}
              </>
            }
          >
            <input
              id={`int-${f.key}`}
              className={`in ${f.secret ? '' : 'mono'}`}
              type={f.secret ? 'password' : 'text'}
              autoComplete={f.secret ? 'new-password' : 'off'}
              placeholder={f.secret && stored ? '•••••••• (kayıtlı)' : f.placeholder}
              value={values[f.key] ?? ''}
              onChange={(e) => setValues((v) => ({ ...v, [f.key]: e.target.value }))}
            />
          </Field>
        );
      })}
    </Drawer>
  );
}
