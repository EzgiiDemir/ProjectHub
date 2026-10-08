'use client';

import DOMPurify from 'dompurify';
import { marked } from 'marked';
import { X } from 'lucide-react';
import { useEffect, useId, useMemo, useState, type ReactNode } from 'react';
import { errorMessage } from '@/lib/api';
import { initials } from '@/lib/format';
import { statusLabel, statusTone, type Tone } from '@/lib/labels';

export function Badge({ tone = 'idle', children, plain }: { tone?: Tone; children: ReactNode; plain?: boolean }) {
  return <span className={`badge ${tone === 'idle' ? '' : `b-${tone}`} ${plain ? 'plain' : ''}`}>{children}</span>;
}

export function StatusBadge({ status, label }: { status: string | null | undefined; label?: string }) {
  return <Badge tone={statusTone(status)}>{label ?? statusLabel(status)}</Badge>;
}

export function Avatar({ name, color, size = 28 }: { name: string; color?: string; size?: number }) {
  return (
    <span className="avatar" style={{ background: color ?? '#5B6772', width: size, height: size, fontSize: Math.max(9, size * 0.38) }} title={name}>
      {initials(name)}
    </span>
  );
}

export function Panel({ title, actions, children, flush, className }: { title?: ReactNode; actions?: ReactNode; children: ReactNode; flush?: boolean; className?: string }) {
  if (flush || title) {
    return (
      <section className={`panel flush ${className ?? ''}`}>
        {title && (
          <div className="panel-h">
            <h2>{title}</h2>
            {actions && <div className="row">{actions}</div>}
          </div>
        )}
        {flush ? children : <div style={{ padding: 16 }}>{children}</div>}
      </section>
    );
  }
  return <section className={`panel ${className ?? ''}`}>{children}</section>;
}

export function PageHeader({ title, sub, actions }: { title: ReactNode; sub?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="spread" style={{ marginBottom: 16 }}>
      <div>
        <h1>{title}</h1>
        {sub && <p className="sub" style={{ margin: '4px 0 0' }}>{sub}</p>}
      </div>
      {actions && <div className="row">{actions}</div>}
    </div>
  );
}

export function Kpi({ value, label, href, tone, color: explicit }: { value: ReactNode; label: string; href?: string; tone?: Tone; color?: string }) {
  const color = explicit ?? (tone && tone !== 'idle' ? `var(--${tone === 'pri' ? 'primary' : tone})` : undefined);
  const inner = (
    <>
      <span>{label}</span>
      <b style={{ color }}>{value}</b>
    </>
  );
  return href ? (
    <a className="panel kpi" href={href}>
      {inner}
    </a>
  ) : (
    <div className="panel kpi">{inner}</div>
  );
}

export function ScoreBar({ label, value }: { label: string; value: number | null }) {
  const color = value === null ? 'var(--idle)' : value >= 85 ? 'var(--ok)' : value >= 70 ? 'var(--warn)' : 'var(--bad)';
  return (
    <div style={{ marginBottom: 8 }}>
      <div className="spread small">
        <span>{label}</span>
        <b>{value ?? '—'}</b>
      </div>
      <div className="bar">
        <i style={{ width: `${value ?? 0}%`, background: color }} />
      </div>
    </div>
  );
}

export const scoreColor = (v: number | null | undefined) => (v === null || v === undefined ? 'var(--idle)' : v >= 85 ? 'var(--ok)' : v >= 70 ? 'var(--warn)' : 'var(--bad)');

export function Empty({ title, children, action }: { title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="empty">
      <b>{title}</b>
      {children && <div style={{ marginBottom: action ? 12 : 0 }}>{children}</div>}
      {action}
    </div>
  );
}

/** Spec §133: what happened, why it may have happened, what you can do. */
export function ErrorState({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  return (
    <div className="badbox" role="alert">
      <b>Bu içerik yüklenemedi.</b> {errorMessage(error)}
      {onRetry && (
        <div style={{ marginTop: 8 }}>
          <button className="btn sm" onClick={onRetry}>
            Tekrar dene
          </button>
        </div>
      )}
    </div>
  );
}

export function Loading({ label = 'Yükleniyor…', rows = 0 }: { label?: string; rows?: number }) {
  if (rows) {
    return (
      <div className="grid" style={{ gap: 8 }} aria-busy="true" aria-label={label}>
        {Array.from({ length: rows }, (_, i) => (
          <div key={i} className="skeleton" style={{ height: 38 }} />
        ))}
      </div>
    );
  }
  return (
    <div className="row muted small" style={{ padding: 16 }} aria-busy="true">
      <span className="spinner" /> {label}
    </div>
  );
}

/** Renders loading / error / content for a react-query result. */
export function Async<T>({ q, children, rows }: { q: { data?: T; isLoading: boolean; error: unknown; refetch: () => unknown }; children: (data: T) => ReactNode; rows?: number }) {
  if (q.isLoading) return <Loading rows={rows ?? 4} />;
  if (q.error) return <ErrorState error={q.error} onRetry={() => void q.refetch()} />;
  if (q.data === undefined) return null;
  return <>{children(q.data)}</>;
}

export function Field({ label, hint, error, children, id }: { label: string; hint?: ReactNode; error?: string | null; children: ReactNode; id?: string }) {
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      {children}
      {error ? <span className="error">{error}</span> : hint ? <span className="hint">{hint}</span> : null}
    </div>
  );
}

export function Modal({ title, onClose, children, footer, wide }: { title: ReactNode; onClose: () => void; children: ReactNode; footer?: ReactNode; wide?: boolean }) {
  useEscape(onClose);
  return (
    <div className="scrim" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal" role="dialog" aria-modal="true" style={wide ? { width: 'min(880px, 94vw)' } : undefined}>
        <div className="dr-h">
          <h2 style={{ margin: 0 }}>{title}</h2>
          <button className="icon-btn" onClick={onClose} aria-label="Kapat">
            <X size={18} />
          </button>
        </div>
        <div className="dr-b">{children}</div>
        {footer && <div className="dr-f">{footer}</div>}
      </div>
    </div>
  );
}

export function Drawer({ title, onClose, children, footer, wide }: { title: ReactNode; onClose: () => void; children: ReactNode; footer?: ReactNode; wide?: boolean }) {
  useEscape(onClose);
  return (
    <div className="scrim" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <aside className={`drawer ${wide ? 'wide' : ''}`} role="dialog" aria-modal="true">
        <div className="dr-h">
          <h2 style={{ margin: 0 }}>{title}</h2>
          <button className="icon-btn" onClick={onClose} aria-label="Kapat">
            <X size={18} />
          </button>
        </div>
        <div className="dr-b">{children}</div>
        {footer && <div className="dr-f">{footer}</div>}
      </aside>
    </div>
  );
}

function useEscape(fn: () => void) {
  useEffect(() => {
    const h = (e: KeyboardEvent) => e.key === 'Escape' && fn();
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [fn]);
}

/** Dangerous actions (spec §134): typed confirmation before the action runs. */
export function ConfirmDialog({
  title,
  message,
  confirmText,
  actionLabel,
  danger = true,
  busy,
  onConfirm,
  onClose,
  children,
}: {
  title: string;
  message: ReactNode;
  confirmText?: string;
  actionLabel: string;
  danger?: boolean;
  busy?: boolean;
  onConfirm: () => void;
  onClose: () => void;
  children?: ReactNode;
}) {
  const [typed, setTyped] = useState('');
  const id = useId();
  const ok = !confirmText || typed === confirmText;
  return (
    <Modal
      title={title}
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            Vazgeç
          </button>
          <button className={`btn ${danger ? 'danger solid' : 'pri'}`} disabled={!ok || busy} onClick={onConfirm}>
            {busy && <span className="spinner" />} {actionLabel}
          </button>
        </>
      }
    >
      <div style={{ marginBottom: 12 }}>{message}</div>
      {children}
      {confirmText && (
        <Field id={id} label={`Onaylamak için "${confirmText}" yazın`}>
          <input id={id} className="in" value={typed} onChange={(e) => setTyped(e.target.value)} autoComplete="off" />
        </Field>
      )}
    </Modal>
  );
}

export function Tabs<T extends string>({ value, onChange, items }: { value: T; onChange: (v: T) => void; items: [T, ReactNode][] }) {
  return (
    <div className="tabs" role="tablist">
      {items.map(([k, label]) => (
        <button key={k} role="tab" aria-selected={value === k} className={value === k ? 'on' : ''} onClick={() => onChange(k)}>
          {label}
        </button>
      ))}
    </div>
  );
}

export function Segmented<T extends string>({ value, onChange, items }: { value: T; onChange: (v: T) => void; items: [T, ReactNode][] }) {
  return (
    <div className="seg">
      {items.map(([k, label]) => (
        <button key={k} type="button" className={value === k ? 'on' : ''} onClick={() => onChange(k)}>
          {label}
        </button>
      ))}
    </div>
  );
}

export function CopyButton({ text, label = 'Kopyala' }: { text: string; label?: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      className="btn sm"
      onClick={async () => {
        await navigator.clipboard.writeText(text);
        setDone(true);
        setTimeout(() => setDone(false), 1500);
      }}
    >
      {done ? 'Kopyalandı' : label}
    </button>
  );
}

/** Markdown rendered and sanitized (README, release notes, AI answers). */
export function Markdown({ text, className = 'prose' }: { text: string; className?: string }) {
  const html = useMemo(() => {
    const raw = marked.parse(text, { async: false, gfm: true, breaks: true }) as string;
    return typeof window === 'undefined' ? '' : DOMPurify.sanitize(raw);
  }, [text]);
  return <div className={className} dangerouslySetInnerHTML={{ __html: html }} />;
}

/** Unified diff renderer (git patch text). */
export function DiffView({ patch, maxHeight }: { patch: string; maxHeight?: number }) {
  if (!patch.trim()) return <Empty title="Fark yok" />;
  return (
    <div className="diff" style={maxHeight ? { maxHeight } : undefined}>
      {patch.split('\n').map((l, i) => {
        const cls = l.startsWith('diff --git') ? 'f' : l.startsWith('@@') ? 'h' : l.startsWith('+') && !l.startsWith('+++') ? 'a' : l.startsWith('-') && !l.startsWith('---') ? 'r' : '';
        const text = l.startsWith('diff --git') ? l.replace(/^diff --git a\/(.*) b\/.*$/, '$1') : l;
        if (l.startsWith('index ') || l.startsWith('+++') || l.startsWith('---')) return null;
        return (
          <div key={i} className={cls}>
            {text || ' '}
          </div>
        );
      })}
    </div>
  );
}

/** Build / deployment log with section headers highlighted. */
export function LogView({ text, maxHeight = 560 }: { text: string; maxHeight?: number }) {
  return (
    <pre className="log" style={{ maxHeight }}>
      {text.split('\n').map((l, i) => (
        <span key={i} className={l.startsWith('━━') ? 'sec' : /\b(error|ERR!|HATA|failed|başarısız)\b/i.test(l) ? 'err' : undefined}>
          {l}
          {'\n'}
        </span>
      ))}
    </pre>
  );
}

export function KeyValue({ items }: { items: [string, ReactNode][] }) {
  return (
    <dl className="kv">
      {items.map(([k, v]) => (
        <div key={k} style={{ display: 'contents' }}>
          <dt>{k}</dt>
          <dd>{v ?? '—'}</dd>
        </div>
      ))}
    </dl>
  );
}

export function Pipeline({ steps }: { steps: { key: string; name: string; status: string; summary?: string | null; output?: string | null }[] }) {
  return (
    <div className="pipe">
      {steps.map((s) => (
        <div key={s.key} className={`pstep ${s.status}`}>
          <span className="ic">{s.status === 'passed' ? '✓' : s.status === 'failed' ? '!' : ''}</span>
          <div style={{ minWidth: 0 }}>
            <div>{s.name}</div>
            {(s.summary ?? s.output) && <div className="small muted ellipsis">{(s.summary ?? s.output ?? '').split('\n')[0]}</div>}
          </div>
          <StatusBadge status={s.status} />
        </div>
      ))}
    </div>
  );
}
