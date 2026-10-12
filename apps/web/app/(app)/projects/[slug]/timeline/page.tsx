'use client';

import { useInfiniteQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { apiPaged } from '@/lib/api';
import { dayLabel, time } from '@/lib/format';
import { useProjectSlug } from '@/lib/hooks';
import { EVENT_KIND } from '@/lib/labels';
import type { ProjectEvent } from '@/lib/types';
import { Badge, Empty, ErrorState, Loading } from '@/components/ui';

const TONE_LABEL: Record<string, string> = { ok: 'tamam', warn: 'dikkat', bad: 'sorun', run: 'sürüyor' };

/** Spec §39 / §135: the project's chronological memory across every module. */
export default function TimelinePage() {
  const slug = useProjectSlug();
  const [kind, setKind] = useState('');
  const q = useInfiniteQuery({
    queryKey: ['timeline', slug, kind],
    queryFn: ({ pageParam }) => apiPaged<ProjectEvent>(`/projects/${slug}/timeline?limit=60${kind ? `&kind=${kind}` : ''}${pageParam ? `&cursor=${encodeURIComponent(pageParam)}` : ''}`),
    initialPageParam: '',
    getNextPageParam: (last) => (last.meta.hasMore ? (last.meta.nextCursor ?? undefined) : undefined),
  });
  const events = q.data?.pages.flatMap((p) => p.data) ?? [];
  const days = [...new Set(events.map((e) => dayLabel(e.createdAt)))];

  return (
    <>
      <div className="spread" style={{ marginBottom: 6 }}>
        <div>
          <h2 style={{ margin: 0 }}>Zaman akışı</h2>
          <p className="sub">Kod, build, kullanıcı, AI ve deployment olaylarının tek kronolojisi.</p>
        </div>
      </div>
      <div className="row" style={{ marginBottom: 8 }}>
        <button className={`chip ${kind === '' ? 'on' : ''}`} onClick={() => setKind('')}>
          Tümü
        </button>
        {Object.entries(EVENT_KIND).map(([k, [label]]) => (
          <button key={k} className={`chip ${kind === k ? 'on' : ''}`} onClick={() => setKind(k)}>
            {label}
          </button>
        ))}
      </div>
      {q.isLoading && <Loading rows={6} />}
      {q.error && <ErrorState error={q.error} onRetry={() => void q.refetch()} />}
      {!q.isLoading && !events.length && <Empty title="Bu filtrede olay yok" />}
      <div className="tl">
        {days.map((d) => (
          <div key={d}>
            <div className="tl-day">{d}</div>
            {events
              .filter((e) => dayLabel(e.createdAt) === d)
              .map((e) => (
                <div key={e.id} className="tl-ev" style={{ ['--kc' as string]: EVENT_KIND[e.kind]?.[1] }}>
                  <div className="tm">{time(e.createdAt)}</div>
                  <div className="bd">
                    <div className="spread">
                      <span className="tl-k">{EVENT_KIND[e.kind]?.[0] ?? e.kind}</span>
                      {e.tone !== 'idle' && (
                        <Badge tone={e.tone} plain>
                          {TONE_LABEL[e.tone]}
                        </Badge>
                      )}
                    </div>
                    <div style={{ fontWeight: 600, fontSize: 13.5 }}>{e.title}</div>
                    {e.description && <div className="small muted" style={{ whiteSpace: 'pre-wrap' }}>{e.description}</div>}
                    <div className="small muted">{e.actorLabel}</div>
                  </div>
                </div>
              ))}
          </div>
        ))}
      </div>
      {q.hasNextPage && (
        <div style={{ textAlign: 'center', marginTop: 12 }}>
          <button className="btn" onClick={() => void q.fetchNextPage()} disabled={q.isFetchingNextPage}>
            Daha eski olaylar
          </button>
        </div>
      )}
    </>
  );
}
