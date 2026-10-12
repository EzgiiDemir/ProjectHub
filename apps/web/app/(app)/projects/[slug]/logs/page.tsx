'use client';

import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { dateTime } from '@/lib/format';
import { useProjectSlug } from '@/lib/hooks';
import type { Environment } from '@/lib/types';
import { Async, Empty, Kpi, Panel, Segmented } from '@/components/ui';

interface LogResult {
  from: string;
  to: string;
  documents: number;
  stats: { error: number; warn: number; lines: number };
  bySource: Record<'build' | 'deployment' | 'preview', { documents: number; error: number; warn: number }>;
  total: number;
  truncated: boolean;
  matches: { source: 'build' | 'deployment' | 'preview'; refId: string; label: string; link: string; environment: string | null; step: string | null; at: string; approximateTime: boolean; line: number; level: 'error' | 'warn' | 'info'; text: string }[];
}

const WINDOWS = { '1h': 3600_000, '24h': 86400_000, '7d': 7 * 86400_000, '30d': 30 * 86400_000 } as const;
const SOURCE_LABEL = { build: 'Build', deployment: 'Deployment', preview: 'Ön izleme' } as const;
const LEVEL_COLOR = { error: 'var(--bad)', warn: 'var(--warn)', info: 'var(--muted)' } as const;

/** Logs page (spec §83): search build, deployment and preview logs by text, source, environment, level and date. */
export default function LogsPage() {
  const slug = useProjectSlug();
  const [text, setText] = useState('');
  const [q, setQ] = useState('');
  const [source, setSource] = useState('');
  const [environmentId, setEnvironmentId] = useState('');
  const [level, setLevel] = useState<'' | 'error' | 'warn'>('');
  const [window, setWindow] = useState<keyof typeof WINDOWS>('24h');
  // Debounced search box.
  useEffect(() => {
    const t = setTimeout(() => setQ(text.trim()), 350);
    return () => clearTimeout(t);
  }, [text]);
  const envs = useQuery({ queryKey: ['environments', slug], queryFn: () => api<Environment[]>(`/projects/${slug}/environments`) });
  const params = new URLSearchParams({ ...(q ? { q } : {}), ...(source ? { source } : {}), ...(environmentId ? { environmentId } : {}), ...(level ? { level } : {}), from: new Date(Date.now() - WINDOWS[window]).toISOString() });
  const logs = useQuery({ queryKey: ['logs', slug, q, source, environmentId, level, window], queryFn: () => api<LogResult>(`/projects/${slug}/logs?${params.toString()}`), placeholderData: (prev) => prev });

  return (
    <>
      <div style={{ marginBottom: 12 }}>
        <h2 style={{ margin: 0 }}>Loglar</h2>
        <p className="sub">Build, deployment ve ön izleme süreçlerinin logları. Seviye, satır içeriğinden çıkarılır.</p>
      </div>
      <div className="row" style={{ flexWrap: 'wrap', gap: 8, marginBottom: 12 }}>
        <input className="in" style={{ flex: '1 1 260px' }} placeholder="Loglarda ara…" value={text} onChange={(e) => setText(e.target.value)} aria-label="Loglarda ara" />
        <select className="in" style={{ width: 160 }} value={source} onChange={(e) => setSource(e.target.value)} aria-label="Kaynak">
          <option value="">Tüm kaynaklar</option>
          <option value="build">Build</option>
          <option value="deployment">Deployment</option>
          <option value="preview">Ön izleme</option>
        </select>
        <select className="in" style={{ width: 170 }} value={environmentId} onChange={(e) => setEnvironmentId(e.target.value)} aria-label="Ortam" title="Ortam seçildiğinde yalnızca o ortamın deployment logları aranır">
          <option value="">Tüm ortamlar</option>
          {(envs.data ?? []).map((e) => (
            <option key={e.id} value={e.id}>
              {e.name}
            </option>
          ))}
        </select>
        <select className="in" style={{ width: 150 }} value={level} onChange={(e) => setLevel(e.target.value as typeof level)} aria-label="Seviye">
          <option value="">Tüm seviyeler</option>
          <option value="error">Hata</option>
          <option value="warn">Uyarı ve üstü</option>
        </select>
        <Segmented
          value={window}
          onChange={setWindow}
          items={[
            ['1h', '1 saat'],
            ['24h', '24 saat'],
            ['7d', '7 gün'],
            ['30d', '30 gün'],
          ]}
        />
      </div>
      <Async q={logs} rows={6}>
        {(r) => (
          <>
            <div className="grid g4" style={{ marginBottom: 14 }}>
              <Kpi value={r.stats.error} label="Hata satırı" tone={r.stats.error ? 'bad' : 'ok'} />
              <Kpi value={r.stats.warn} label="Uyarı satırı" tone={r.stats.warn ? 'warn' : 'ok'} />
              <Kpi value={r.stats.lines} label="Taranan satır" />
              <Kpi value={r.documents} label="Log kaydı" />
            </div>
            {r.stats.error > 0 && (
              <p className="small" style={{ marginTop: 0 }}>
                Seçilen aralıkta {r.stats.error} hata satırı:{' '}
                {(Object.keys(SOURCE_LABEL) as (keyof typeof SOURCE_LABEL)[])
                  .filter((s) => r.bySource[s].error)
                  .map((s) => `${SOURCE_LABEL[s]} ${r.bySource[s].error} (%${Math.round((r.bySource[s].error / r.stats.error) * 100)})`)
                  .join(' · ')}
              </p>
            )}
            <Panel flush>
              {r.matches.length ? (
                <div className="logsearch">
                  {r.matches.map((m, i) => (
                    <div key={`${m.refId}-${m.line}-${i}`} className="logrow">
                      <span className="muted" title={m.approximateTime ? 'Süreç logu satır zamanı tutmaz: dosyanın son yazılma zamanı' : m.at}>
                        {m.approximateTime && '~'}
                        {dateTime(m.at)}
                      </span>
                      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        <Link href={m.link}>{m.label}</Link>
                        {m.environment && <span className="muted"> · {m.environment}</span>}
                        {m.step && <span className="muted"> · {m.step}</span>}
                      </span>
                      <span style={{ color: LEVEL_COLOR[m.level], whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{m.text}</span>
                    </div>
                  ))}
                </div>
              ) : (
                <Empty title="Eşleşen satır yok">Arama metnini, filtreleri veya zaman aralığını değiştirin.</Empty>
              )}
            </Panel>
            {r.truncated && <p className="small muted">{r.total} eşleşmenin en yeni {r.matches.length} tanesi gösteriliyor; aramayı daraltın.</p>}
          </>
        )}
      </Async>
    </>
  );
}
