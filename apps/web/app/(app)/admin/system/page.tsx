'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, errorMessage } from '@/lib/api';
import { ago, bytes } from '@/lib/format';
import { Async, Badge, Kpi, PageHeader, Panel, StatusBadge } from '@/components/ui';
import { useToast } from '@/components/toast';

interface SystemStatus {
  host: { hostname: string; platform: string; cpus: number; loadAverage: number[]; memory: { total: number; free: number }; uptimeSeconds: number; nodeVersion: string };
  disk: { total: number; free: number } | null;
  storage: Record<string, number>;
  workers: { workerId: string; hostname: string; pid: number; queues: string[]; startedAt: string; lastSeenAt: string; info: { rss?: number; activeJobs?: number }; healthy: boolean }[];
  queues: { queue: string; status: string; n: number }[];
  failedJobs: { id: string; type: string; lastError: string | null; finishedAt: string | null; attempts: number }[];
  services: Record<string, boolean>;
}

const STORAGE: Record<string, string> = { repos: 'Git repository’leri', artifacts: 'Build çıktıları ve ekran görüntüleri', workspaces: 'Geçici build alanı', logs: 'Loglar', backups: 'Veritabanı yedekleri', uploads: 'Yüklemeler', database: 'PostgreSQL' };
const SERVICE: Record<string, [string, string]> = {
  api: ['API', 'İstekleri karşılıyor'],
  database: ['PostgreSQL', 'Bağlantı var'],
  worker: ['Worker', 'Build, ön izleme, deployment ve AI işlerini çalıştırır'],
  ai: ['AI sağlayıcısı', 'API anahtarı tanımlı'],
  smtp: ['E-posta (SMTP)', 'Davet ve bildirim e-postaları'],
  dependencyDatabase: ['Açık veritabanı (OSV.dev)', 'Bağımlılık güvenlik taraması'],
};

/** Infrastructure and system health (spec §20–22, §108): sized for one 8 GB server, so capacity is visible. */
export default function SystemPage() {
  const qc = useQueryClient();
  const toast = useToast();
  const q = useQuery({ queryKey: ['system'], queryFn: () => api<SystemStatus>('/admin/system'), refetchInterval: 15_000 });
  const retry = useMutation({
    mutationFn: (id: string) => api(`/admin/jobs/${id}/retry`, { method: 'POST' }),
    onSuccess: () => (toast('İş yeniden kuyruğa alındı'), void qc.invalidateQueries({ queryKey: ['system'] })),
    onError: (e) => toast(errorMessage(e), 'bad'),
  });
  return (
    <div className="page">
      <PageHeader title="Altyapı ve sistem sağlığı" sub="Sunucu kaynakları, depolama kullanımı, worker'lar ve iş kuyrukları." />
      <Async q={q} rows={8}>
        {(s) => {
          const memUsed = s.host.memory.total - s.host.memory.free;
          const diskUsed = s.disk ? s.disk.total - s.disk.free : null;
          const queues = [...new Set(s.queues.map((x) => x.queue))].sort();
          const totalStorage = Object.values(s.storage).reduce((a, b) => a + b, 0);
          return (
            <>
              <div className="grid g4" style={{ marginBottom: 14 }}>
                <Kpi value={`%${Math.round((memUsed / s.host.memory.total) * 100)}`} label={`Bellek · ${bytes(memUsed)} / ${bytes(s.host.memory.total)}`} tone={memUsed / s.host.memory.total > 0.9 ? 'bad' : undefined} />
                <Kpi value={s.disk && diskUsed !== null ? `%${Math.round((diskUsed / s.disk.total) * 100)}` : '—'} label={s.disk ? `Disk · ${bytes(s.disk.free)} boş` : 'Disk'} tone={s.disk && s.disk.free / s.disk.total < 0.1 ? 'bad' : undefined} />
                <Kpi value={bytes(totalStorage)} label="Project Hub verisi" />
                <Kpi value={s.workers.filter((w) => w.healthy).length} label="Çalışan worker" tone={s.workers.some((w) => w.healthy) ? 'ok' : 'bad'} />
              </div>
              <div className="grid g3" style={{ alignItems: 'start', marginBottom: 14 }}>
                <Panel title="Servisler" flush>
                  {Object.entries(SERVICE).map(([k, [label, hint]]) => (
                    <div key={k} className="list-item">
                      <div style={{ flex: 1 }}>
                        {label}
                        <div className="small muted">{hint}</div>
                      </div>
                      {s.services[k] ? <StatusBadge status="healthy" label="Çalışıyor" /> : <StatusBadge status={k === 'ai' || k === 'smtp' ? 'unknown' : 'down'} label={k === 'ai' || k === 'smtp' ? 'Tanımlı değil' : 'Erişilemiyor'} />}
                    </div>
                  ))}
                </Panel>
                <Panel title="Depolama">
                  {Object.entries(s.storage)
                    .sort((a, b) => b[1] - a[1])
                    .map(([k, v]) => (
                      <div key={k} style={{ marginBottom: 8 }}>
                        <div className="spread small">
                          <span>{STORAGE[k] ?? k}</span>
                          <b>{bytes(v)}</b>
                        </div>
                        <div className="bar">
                          <i style={{ width: `${totalStorage ? Math.max(1, (v / totalStorage) * 100) : 0}%` }} />
                        </div>
                      </div>
                    ))}
                  <p className="small muted" style={{ marginBottom: 0 }}>Saklama süreleri “Saklama ve kapasite” ekranından ayarlanır; eski build çıktıları ve loglar saatlik temizlenir.</p>
                </Panel>
                <Panel title="Sunucu">
                  <dl className="kv">
                    <dt>Ad</dt>
                    <dd>{s.host.hostname}</dd>
                    <dt>Sistem</dt>
                    <dd>{s.host.platform}</dd>
                    <dt>CPU</dt>
                    <dd>
                      {s.host.cpus} çekirdek{s.host.loadAverage[0] ? ` · yük ${s.host.loadAverage.map((l) => l.toFixed(2)).join(' / ')}` : ''}
                    </dd>
                    <dt>Node.js</dt>
                    <dd>{s.host.nodeVersion}</dd>
                    <dt>Çalışma süresi</dt>
                    <dd>{Math.floor(s.host.uptimeSeconds / 86400)} gün {Math.floor((s.host.uptimeSeconds % 86400) / 3600)} saat</dd>
                  </dl>
                </Panel>
              </div>
              <div className="grid g2" style={{ alignItems: 'start' }}>
                <Panel title="Worker'lar" flush>
                  {s.workers.length ? (
                    s.workers.map((w) => (
                      <div key={w.workerId} className="list-item">
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <span className="mono small">{w.workerId}</span>
                          <div className="small muted">
                            {w.info.activeJobs ?? 0} aktif iş · {w.info.rss ? bytes(w.info.rss) : '—'} bellek · başladı {ago(w.startedAt)}
                          </div>
                        </div>
                        {w.healthy ? <StatusBadge status="healthy" label="Canlı" /> : <StatusBadge status="down" label={`Sessiz · ${ago(w.lastSeenAt)}`} />}
                      </div>
                    ))
                  ) : (
                    <div className="list-item badbox">Worker çalışmıyor. Build, ön izleme ve deployment işleri bekler.</div>
                  )}
                </Panel>
                <Panel title="Kuyruklar (son 24 saat)">
                  {queues.length ? (
                    <div className="tbl">
                      <table>
                        <thead>
                          <tr>
                            <th>Kuyruk</th>
                            <th>Bekleyen</th>
                            <th>Çalışan</th>
                            <th>Başarısız</th>
                          </tr>
                        </thead>
                        <tbody>
                          {queues.map((name) => {
                            const n = (st: string) => s.queues.find((x) => x.queue === name && x.status === st)?.n ?? 0;
                            return (
                              <tr key={name}>
                                <td className="mono small">{name}</td>
                                <td>{n('queued')}</td>
                                <td>{n('running')}</td>
                                <td style={{ color: n('failed') ? 'var(--bad)' : undefined }}>{n('failed')}</td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                  ) : (
                    <p className="small muted" style={{ margin: 0 }}>Kuyruklar boş.</p>
                  )}
                </Panel>
              </div>
              {s.failedJobs.length > 0 && (
                <Panel title="Başarısız işler" flush className="mt">
                  {s.failedJobs.map((j) => (
                    <div key={j.id} className="list-item">
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <span className="mono small">{j.type}</span> <Badge tone="bad" plain>{j.attempts} deneme</Badge>
                        <div className="small muted ellipsis">{j.lastError}</div>
                      </div>
                      <span className="small muted">{ago(j.finishedAt)}</span>
                      <button className="btn sm" onClick={() => retry.mutate(j.id)} disabled={retry.isPending}>
                        Tekrar dene
                      </button>
                    </div>
                  ))}
                </Panel>
              )}
            </>
          );
        }}
      </Async>
    </div>
  );
}
