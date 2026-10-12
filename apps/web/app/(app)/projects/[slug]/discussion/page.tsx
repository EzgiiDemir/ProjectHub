'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Pin } from 'lucide-react';
import { useState } from 'react';
import { api, errorMessage } from '@/lib/api';
import { ago, dateTime } from '@/lib/format';
import { useProjectSlug } from '@/lib/hooks';
import { Async, Avatar, Empty, Panel } from '@/components/ui';
import { useToast } from '@/components/toast';

interface Person {
  id: string;
  displayName: string;
  avatarColor: string;
}
interface Comment {
  id: string;
  body: string;
  at: string;
  pinned: boolean;
  author: Person | null;
  mentions: Person[];
  mine: boolean;
}
interface Discussion {
  threads: (Comment & { replies: Comment[] })[];
  canPost: boolean;
  canModerate: boolean;
  people: Person[];
}

/** Project discussion: threads with replies, @mentions (notified) and pinned announcements. */
export default function DiscussionPage() {
  const slug = useProjectSlug();
  const q = useQuery({ queryKey: ['discussion', slug], queryFn: () => api<Discussion>(`/projects/${slug}/discussion`) });
  return (
    <>
      <div style={{ marginBottom: 16 }}>
        <h2 style={{ margin: 0 }}>Tartışma</h2>
        <p className="sub">Proje ekibiyle konuşun. Bahsettiğiniz kişiye bildirim gider; önemli duyuruları sabitleyebilirsiniz.</p>
      </div>
      <Async q={q} rows={4}>
        {(d) => (
          <div style={{ display: 'grid', gap: 16, maxWidth: 920 }}>
            {d.canPost && <Composer slug={slug} people={d.people} />}
            {d.threads.length ? d.threads.map((t) => <Thread key={t.id} slug={slug} t={t} d={d} />) : <Empty title="Henüz tartışma yok">İlk mesajı yazarak başlayın.</Empty>}
          </div>
        )}
      </Async>
    </>
  );
}

function Composer({ slug, people, parentId, onDone }: { slug: string; people: Person[]; parentId?: string; onDone?: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [body, setBody] = useState('');
  const [mentions, setMentions] = useState<string[]>([]);
  const post = useMutation({
    mutationFn: () => api(`/projects/${slug}/discussion`, { method: 'POST', body: { body, parentId, mentions } }),
    onSuccess: () => {
      setBody('');
      setMentions([]);
      void qc.invalidateQueries({ queryKey: ['discussion', slug] });
      onDone?.();
    },
    onError: (e) => toast(errorMessage(e), 'bad'),
  });
  const add = (id: string) => {
    const p = people.find((x) => x.id === id);
    if (!p || mentions.includes(id)) return;
    setMentions((m) => [...m, id]);
    setBody((b) => `${b}${b && !b.endsWith(' ') ? ' ' : ''}@${p.displayName} `);
  };
  return (
    <div className={parentId ? 'reply-box' : 'panel composer'}>
      <textarea className="in" rows={parentId ? 2 : 3} placeholder={parentId ? 'Yanıt yazın…' : 'Ekiple paylaşmak istediğiniz şeyi yazın…'} value={body} onChange={(e) => setBody(e.target.value)} maxLength={5000} aria-label={parentId ? 'Yanıt' : 'Mesaj'} />
      <div className="row" style={{ marginTop: 8, gap: 8, flexWrap: 'wrap' }}>
        <select className="in" style={{ width: 'auto' }} value="" onChange={(e) => add(e.target.value)} aria-label="Kişiden bahset">
          <option value="">@ Kişiden bahset…</option>
          {people
            .filter((p) => !mentions.includes(p.id))
            .map((p) => (
              <option key={p.id} value={p.id}>
                {p.displayName}
              </option>
            ))}
        </select>
        <span style={{ flex: 1 }} />
        {onDone && (
          <button className="btn" onClick={onDone}>
            Vazgeç
          </button>
        )}
        <button className="btn pri" disabled={!body.trim() || post.isPending} onClick={() => post.mutate()}>
          {parentId ? 'Yanıtla' : 'Gönder'}
        </button>
      </div>
    </div>
  );
}

function Message({ c, slug, canModerate, root }: { c: Comment; slug: string; canModerate: boolean; root?: boolean }) {
  const qc = useQueryClient();
  const toast = useToast();
  const act = useMutation({
    mutationFn: (action: 'delete' | 'pin' | 'unpin') => api(`/discussion/${c.id}/${action}`, { method: 'POST' }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['discussion', slug] }),
    onError: (e) => toast(errorMessage(e), 'bad'),
  });
  return (
    <div className="message">
      {c.author ? <Avatar name={c.author.displayName} color={c.author.avatarColor} size={root ? 34 : 28} /> : <span />}
      <div style={{ minWidth: 0 }}>
        <div className="row" style={{ gap: 8 }}>
          <b>{c.author?.displayName ?? 'Silinmiş kullanıcı'}</b>
          <span className="small muted" title={dateTime(c.at)}>
            {ago(c.at)}
          </span>
          {c.pinned && (
            <span className="tag">
              <Pin size={11} /> Sabit
            </span>
          )}
          <span style={{ flex: 1 }} />
          {root && canModerate && (
            <button className="btn sm ghost" onClick={() => act.mutate(c.pinned ? 'unpin' : 'pin')}>
              {c.pinned ? 'Sabitlemeyi kaldır' : 'Sabitle'}
            </button>
          )}
          {(c.mine || canModerate) && (
            <button className="btn sm ghost" onClick={() => act.mutate('delete')}>
              Sil
            </button>
          )}
        </div>
        <div className="message-body">{c.body}</div>
      </div>
    </div>
  );
}

function Thread({ slug, t, d }: { slug: string; t: Discussion['threads'][number]; d: Discussion }) {
  const [replying, setReplying] = useState(false);
  return (
    <Panel>
      <Message c={t} slug={slug} canModerate={d.canModerate} root />
      {t.replies.length > 0 && (
        <div className="replies">
          {t.replies.map((r) => (
            <Message key={r.id} c={r} slug={slug} canModerate={d.canModerate} />
          ))}
        </div>
      )}
      {d.canPost &&
        (replying ? (
          <div className="replies">
            <Composer slug={slug} people={d.people} parentId={t.id} onDone={() => setReplying(false)} />
          </div>
        ) : (
          <button className="btn sm" style={{ marginTop: 10, marginLeft: 46 }} onClick={() => setReplying(true)}>
            Yanıtla
          </button>
        ))}
    </Panel>
  );
}
