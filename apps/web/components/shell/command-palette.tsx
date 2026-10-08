'use client';

import { useQuery } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';
import { useEffect, useMemo, useRef, useState } from 'react';
import { api } from '@/lib/api';
import { useMe } from '@/lib/hooks';
import type { ProjectSummary } from '@/lib/types';

interface SearchResult {
  projects: { id: string; name: string; slug: string; customerName: string }[];
  feedback: { id: string; key: string; title: string; projectSlug?: string; projectName?: string }[];
  code: { path: string; line: number; snippet: string; projectSlug?: string; projectName?: string }[];
  builds: { id: string; number: number; branch: string; status: string; projectSlug?: string; projectName?: string }[];
  deployments: { id: string; key: string; version: string; env: string; projectSlug?: string; projectName?: string }[];
  tasks: { id: string; key: string; title: string; projectSlug?: string }[];
  findings: { id: string; key: string; title: string; severity: string; projectSlug?: string }[];
}

interface Item {
  group: string;
  label: string;
  hint?: string;
  href: string;
}

/**
 * Ctrl/Cmd+K (spec §13, §41): navigation commands ("deploy crm", "open ecommerce", "scan api")
 * plus universal search across projects, code, feedback, builds, deployments, tasks and findings.
 */
export function CommandPalette({ onClose }: { onClose: () => void }) {
  const router = useRouter();
  const me = useMe().data;
  const [q, setQ] = useState('');
  const [debounced, setDebounced] = useState('');
  const [index, setIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => inputRef.current?.focus(), []);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(q.trim()), 200);
    return () => clearTimeout(t);
  }, [q]);
  const projects = useQuery({ queryKey: ['projects', 'sidebar'], queryFn: () => api<ProjectSummary[]>('/projects?status=all') });
  const search = useQuery({
    queryKey: ['search', debounced],
    queryFn: () => api<SearchResult>(`/search?q=${encodeURIComponent(debounced)}&limit=6`),
    enabled: debounced.length >= 2,
  });

  const items = useMemo<Item[]>(() => {
    const list: Item[] = [];
    const words = q.toLowerCase().trim().split(/\s+/).filter(Boolean);
    const verb = words[0] ?? '';
    const rest = words.slice(1).join(' ');
    const match = (p: ProjectSummary, term: string) => !term || p.name.toLowerCase().includes(term) || p.slug.includes(term);
    const ps = projects.data ?? [];
    const verbs: Record<string, [string, string]> = {
      open: ['Aç', ''],
      aç: ['Aç', ''],
      deploy: ['Deploy et', '/environments'],
      build: ['Build başlat', '/builds'],
      scan: ['Güvenlik taraması', '/security'],
      tara: ['Güvenlik taraması', '/security'],
      preview: ['Ön izlemeler', '/previews'],
      review: ['Müşteri linkleri', '/reviews'],
      feedback: ['Geri bildirimler', '/feedback'],
      ai: ['Proje AI\'ya sor', '/ai'],
      sor: ['Proje AI\'ya sor', '/ai'],
      kod: ['Kod', '/code'],
      code: ['Kod', '/code'],
    };
    if (verbs[verb]) {
      const [label, suffix] = verbs[verb];
      for (const p of ps.filter((x) => match(x, rest)).slice(0, 6)) list.push({ group: 'Komutlar', label: `${label}: ${p.name}`, href: `/projects/${p.slug}${suffix}` });
    }
    if (!q) {
      list.push({ group: 'Gezinti', label: 'Ana sayfa', href: '/' });
      list.push({ group: 'Gezinti', label: 'Projeler', href: '/projects' });
      if (me?.permissions.includes('project.create')) list.push({ group: 'Gezinti', label: 'Yeni proje / içe aktar', href: '/projects/new' });
      list.push({ group: 'Gezinti', label: 'Deployment merkezi', href: '/deployments' });
      list.push({ group: 'Gezinti', label: 'Güvenlik merkezi', href: '/security' });
      list.push({ group: 'İpucu', label: '"deploy crm", "build shop", "ai checkout", "scan api" yazmayı deneyin', href: '#' });
    }
    if (q && !verbs[verb]) for (const p of ps.filter((x) => match(x, q.toLowerCase())).slice(0, 5)) list.push({ group: 'Projeler', label: p.name, hint: p.customerName, href: `/projects/${p.slug}` });
    const r = search.data;
    if (r) {
      for (const f of r.feedback) list.push({ group: 'Geri bildirim', label: `${f.key} ${f.title}`, hint: f.projectName, href: `/projects/${f.projectSlug}/feedback/${f.id}` });
      for (const c of r.code) list.push({ group: 'Kod', label: `${c.path}:${c.line}`, hint: c.snippet, href: `/projects/${c.projectSlug}/code?path=${encodeURIComponent(c.path)}&line=${c.line}` });
      for (const b of r.builds) list.push({ group: 'Build', label: `#${b.number} ${b.branch}`, hint: `${b.projectName} · ${b.status}`, href: `/projects/${b.projectSlug}/builds/${b.id}` });
      for (const d of r.deployments) list.push({ group: 'Deployment', label: `${d.key} v${d.version} → ${d.env}`, hint: d.projectName, href: `/projects/${d.projectSlug}/deployments/${d.id}` });
      for (const t of r.tasks) list.push({ group: 'Görev', label: `${t.key} ${t.title}`, href: `/projects/${t.projectSlug}/tasks` });
      for (const f of r.findings) list.push({ group: 'Güvenlik', label: `${f.key} ${f.title}`, hint: f.severity, href: `/projects/${f.projectSlug}/security` });
    }
    return list;
  }, [q, projects.data, search.data, me]);

  useEffect(() => setIndex(0), [items.length]);

  const go = (item: Item | undefined) => {
    if (!item || item.href === '#') return;
    onClose();
    router.push(item.href);
  };

  let lastGroup = '';
  return (
    <div className="scrim" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="palette" role="dialog" aria-label="Komut paleti">
        <input
          ref={inputRef}
          placeholder="Ara veya komut yaz: deploy, build, ai, scan…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') onClose();
            else if (e.key === 'ArrowDown') {
              e.preventDefault();
              setIndex((i) => Math.min(items.length - 1, i + 1));
            } else if (e.key === 'ArrowUp') {
              e.preventDefault();
              setIndex((i) => Math.max(0, i - 1));
            } else if (e.key === 'Enter') go(items[index]);
          }}
        />
        <div className="pal-list">
          {search.isFetching && <div className="pal-grp">Aranıyor…</div>}
          {items.map((it, i) => {
            const header = it.group !== lastGroup ? <div className="pal-grp">{it.group}</div> : null;
            lastGroup = it.group;
            return (
              <div key={`${it.group}-${i}`}>
                {header}
                <button className={`pal-item ${i === index ? 'on' : ''}`} onMouseEnter={() => setIndex(i)} onClick={() => go(it)}>
                  <span className="ellipsis">{it.label}</span>
                  {it.hint && <span className="k ellipsis" style={{ maxWidth: 260 }}>{it.hint}</span>}
                </button>
              </div>
            );
          })}
          {!items.length && debounced.length >= 2 && !search.isFetching && <div className="empty">Sonuç bulunamadı</div>}
        </div>
      </div>
    </div>
  );
}
