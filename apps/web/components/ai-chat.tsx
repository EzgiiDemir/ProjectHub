'use client';

import { useQuery } from '@tanstack/react-query';
import { Send, Square } from 'lucide-react';
import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import { api, errorMessage, postStream } from '@/lib/api';
import { useCan } from '@/lib/hooks';
import type { AiStatus, Citation } from '@/lib/types';
import { Markdown } from './ui';

export interface ChatTurn {
  role: 'user' | 'assistant';
  content: string;
  citations?: Citation[];
  error?: boolean;
}

export function citationHref(slug: string, c: Citation): string {
  const base = `/projects/${slug}`;
  switch (c.type) {
    case 'file':
      return `${base}/code?path=${encodeURIComponent(c.ref)}${c.line ? `&line=${c.line}` : ''}`;
    case 'build':
      return `${base}/builds/${c.ref}`;
    case 'deployment':
      return `${base}/deployments/${c.ref}`;
    case 'feedback':
      return `${base}/feedback/${c.ref}`;
    case 'finding':
      return `${base}/security?finding=${c.ref}`;
    case 'memory':
      return `${base}/ai?tab=memory&memory=${c.ref}`;
    default:
      return base;
  }
}

export function useAiStatus() {
  return useQuery({ queryKey: ['aiStatus'], queryFn: () => api<AiStatus>('/ai/status'), staleTime: 60_000 });
}

/** Shown wherever AI is offered but no provider is configured (spec: AI must never be a silent dead end). */
export function AiNotConfigured({ reason }: { reason?: string | null }) {
  const can = useCan();
  return (
    <div className="warnbox small">
      <b>AI yapılandırılmamış.</b> {reason ?? 'Bir AI sağlayıcısı ve API anahtarı tanımlanmalı.'}{' '}
      {can('admin.settings.manage') ? <Link href="/admin/ai">AI kontrol merkezi</Link> : 'Yöneticinizden AI sağlayıcısını etkinleştirmesini isteyin.'}
    </div>
  );
}

/**
 * Project Brain Q&A. Answers stream token by token over SSE; the final event carries the sources
 * (files, builds, feedback, findings, deployments) the answer relied on.
 */
export function AiChat({
  slug,
  filePath,
  conversationId: initialConversation,
  initialTurns = [],
  onConversation,
  placeholder = 'Proje hakkında sorun…',
  suggestions = [],
  compact,
}: {
  slug: string;
  filePath?: string | null;
  conversationId?: string | null;
  initialTurns?: ChatTurn[];
  onConversation?: (id: string) => void;
  placeholder?: string;
  suggestions?: string[];
  compact?: boolean;
}) {
  const status = useAiStatus();
  const [turns, setTurns] = useState<ChatTurn[]>(initialTurns);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const conversation = useRef<string | null>(initialConversation ?? null);
  const abort = useRef<AbortController | null>(null);
  const end = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setTurns(initialTurns);
    conversation.current = initialConversation ?? null;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialConversation]);
  useEffect(() => {
    void end.current?.scrollIntoView({ block: 'end' });
  }, [turns]);
  useEffect(() => () => abort.current?.abort(), []);

  const ask = async (message: string) => {
    if (!message.trim() || busy) return;
    setText('');
    setBusy(true);
    setTurns((t) => [...t, { role: 'user', content: message }, { role: 'assistant', content: '' }]);
    const ctrl = new AbortController();
    abort.current = ctrl;
    const patchLast = (fn: (t: ChatTurn) => ChatTurn) => setTurns((all) => [...all.slice(0, -1), fn(all[all.length - 1]!)]);
    try {
      await postStream(
        `/projects/${slug}/ai/ask`,
        { message, conversationId: conversation.current ?? undefined, filePath: filePath ?? undefined },
        (event, data) => {
          if (event === 'delta') patchLast((t) => ({ ...t, content: t.content + (data as { text: string }).text }));
          else if (event === 'done') {
            const d = data as { conversationId: string; citations: Citation[] };
            if (!conversation.current) onConversation?.(d.conversationId);
            conversation.current = d.conversationId;
            patchLast((t) => ({ ...t, citations: d.citations }));
          } else if (event === 'error') patchLast((t) => ({ ...t, content: (data as { message: string }).message, error: true }));
        },
        ctrl.signal,
      );
    } catch (e) {
      if ((e as Error).name !== 'AbortError') patchLast((t) => ({ ...t, content: errorMessage(e), error: true }));
    } finally {
      setBusy(false);
      abort.current = null;
    }
  };

  if (status.data && !status.data.configured) {
    return (
      <div style={{ padding: 12 }}>
        <AiNotConfigured reason={status.data.reason} />
      </div>
    );
  }

  return (
    <>
      <div className="chat">
        {!turns.length && (
          <div className="small muted">
            <p style={{ marginTop: 0 }}>
              {filePath ? (
                <>
                  Açık dosya: <span className="mono">{filePath}</span>. AI cevaplarını kod indeksine, build, deployment ve geri bildirim geçmişine dayandırır; kod değiştirmez.
                </>
              ) : (
                'AI cevaplarını projenin kod indeksine, build, deployment, geri bildirim ve güvenlik geçmişine dayandırır; kaynakları gösterir ve kod değiştirmez.'
              )}
            </p>
            {suggestions.map((s) => (
              <button key={s} className="chip" style={{ margin: '0 6px 6px 0' }} onClick={() => void ask(s)}>
                {s}
              </button>
            ))}
          </div>
        )}
        {turns.map((t, i) =>
          t.role === 'user' ? (
            <div key={i} className="msg me">
              {t.content}
            </div>
          ) : (
            <div key={i} className="msg ai" style={t.error ? { borderColor: 'var(--bad)', color: 'var(--bad)' } : undefined}>
              {t.content ? <Markdown text={t.content} className={`prose ${compact ? 'small' : ''}`} /> : <span className="spinner" />}
              {!!t.citations?.length && (
                <div className="src">
                  Kaynaklar:{' '}
                  {t.citations.map((c, k) => (
                    <span key={k}>
                      {k > 0 && ' · '}
                      <Link href={citationHref(slug, c)} className="mono">
                        {c.label}
                      </Link>
                    </span>
                  ))}
                </div>
              )}
            </div>
          ),
        )}
        <div ref={end} />
      </div>
      <form
        className="chat-in"
        onSubmit={(e) => {
          e.preventDefault();
          void ask(text);
        }}
      >
        <textarea
          className="in"
          rows={compact ? 2 : 2}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              void ask(text);
            }
          }}
          placeholder={placeholder}
          maxLength={4000}
          style={{ minHeight: 0, resize: 'none' }}
        />
        {busy ? (
          <button type="button" className="btn" onClick={() => abort.current?.abort()} title="Durdur">
            <Square />
          </button>
        ) : (
          <button className="btn pri" disabled={!text.trim()} title="Gönder">
            <Send />
          </button>
        )}
      </form>
    </>
  );
}
