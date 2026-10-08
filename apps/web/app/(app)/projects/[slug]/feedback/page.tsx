'use client';

import { useQuery } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { api } from '@/lib/api';
import { ago } from '@/lib/format';
import { useProjectSlug } from '@/lib/hooks';
import { FEEDBACK_TYPE, PRIORITY } from '@/lib/labels';
import type { Feedback } from '@/lib/types';
import { Async, Avatar, Badge, Empty, Panel, StatusBadge } from '@/components/ui';

const FILTERS: [string, string][] = [
  ['open', 'Açık'],
  ['mine', 'Bana atanan'],
  ['ready_for_review', 'Müşteri onayında'],
  ['resolved', 'Çözüldü'],
  ['all', 'Tümü'],
];

/** Feedback inbox (spec §61–66): customer and internal QA feedback with its captured context. */
export default function FeedbackPage() {
  const slug = useProjectSlug();
  const router = useRouter();
  const [filter, setFilter] = useState('open');
  const [type, setType] = useState('');
  const query = filter === 'open' ? 'open=true' : filter === 'mine' ? 'assignee=me' : filter === 'all' ? '' : `status=${filter}`;
  const q = useQuery({ queryKey: ['feedback', slug, query], queryFn: () => api<Feedback[]>(`/projects/${slug}/feedback?${query}`) });

  return (
    <>
      <div style={{ marginBottom: 12 }}>
        <h2 style={{ margin: 0 }}>Geri bildirimler</h2>
        <p className="sub">Müşteri linklerinden ve ekip içi testlerden gelen yorum, hata ve değişiklik talepleri; sayfa, cihaz ve ekran görüntüsüyle birlikte.</p>
      </div>
      <div className="spread" style={{ marginBottom: 10 }}>
        <div className="row">
          {FILTERS.map(([k, l]) => (
            <button key={k} className={`chip ${filter === k ? 'on' : ''}`} onClick={() => setFilter(k)}>
              {l}
            </button>
          ))}
        </div>
        <select className="in" style={{ width: 'auto' }} value={type} onChange={(e) => setType(e.target.value)} aria-label="Tür">
          <option value="">Tüm türler</option>
          {Object.entries(FEEDBACK_TYPE).map(([k, l]) => (
            <option key={k} value={k}>
              {l}
            </option>
          ))}
        </select>
      </div>
      <Async q={q} rows={6}>
        {(all) => {
          const rows = type ? all.filter((f) => f.type === type) : all;
          return rows.length ? (
            <Panel flush>
              <div className="tbl">
                <table>
                  <thead>
                    <tr>
                      <th>No</th>
                      <th>Geri bildirim</th>
                      <th>Bildiren</th>
                      <th>Öncelik</th>
                      <th>Durum</th>
                      <th>Atanan</th>
                      <th>Zaman</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((f) => (
                      <tr key={f.id} className="click" onClick={() => router.push(`/projects/${slug}/feedback/${f.id}`)}>
                        <td className="mono small">{f.key}</td>
                        <td style={{ maxWidth: 380 }}>
                          <div className="ellipsis">
                            <Badge tone={f.type === 'bug' ? 'bad' : f.type === 'change_request' ? 'amber' : 'idle'} plain>
                              {FEEDBACK_TYPE[f.type]}
                            </Badge>{' '}
                            {f.title}
                          </div>
                          <div className="small muted mono ellipsis">
                            {safePath(f.pageUrl)}
                            {f.viewport ? ` · ${f.viewport.width}×${f.viewport.height}` : ''}
                            {f.taskKey ? ` · ${f.taskKey}` : ''}
                          </div>
                        </td>
                        <td className="small">
                          {f.reporter.name}
                          {f.reporter.department && <div><span className="dept">{f.reporter.department}</span></div>}
                        </td>
                        <td>
                          <StatusBadge status={f.priority} label={PRIORITY[f.priority]} />
                        </td>
                        <td>
                          <StatusBadge status={f.status} label={f.statusLabel} />
                        </td>
                        <td>{f.assignee ? <Avatar name={f.assignee.displayName} color={f.assignee.avatarColor} size={24} /> : <span className="small muted">—</span>}</td>
                        <td className="small muted">{ago(f.createdAt)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Panel>
          ) : (
            <Empty title="Bu filtrede geri bildirim yok">Müşteri linki gönderdiğinizde gelen geri bildirimler burada toplanır.</Empty>
          );
        }}
      </Async>
    </>
  );
}

function safePath(url: string) {
  try {
    const u = new URL(url);
    return u.pathname + u.search;
  } catch {
    return url;
  }
}
