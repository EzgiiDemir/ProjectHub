'use client';

import { Bot, Code2, Eye, Rocket, Send } from 'lucide-react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import type { ReactNode } from 'react';
import type { Permission } from '@projecthub/contracts';
import { useProject, useProjectSlug } from '@/lib/hooks';
import { ErrorState, Loading, StatusBadge } from '@/components/ui';

/** Two-level project navigation: group tabs, then the active group's pages (no side column, nothing cramped). */
const NAV: [string, [string, string, Permission?][]][] = [
  ['Genel', [['', 'Genel bakış'], ['timeline', 'Zaman akışı'], ['discussion', 'Tartışma']]],
  ['Kod', [['code', 'Kod'], ['pull-requests', 'Pull request\'ler'], ['git', 'Branch ve commit'], ['builds', 'Build\'ler']]],
  ['Çalıştır', [['previews', 'Ön izleme'], ['simulator', 'Simülatör']]],
  ['Kullanıcı', [['reviews', 'Kullanıcı linkleri'], ['feedback', 'Geri bildirimler'], ['tasks', 'Görevler']]],
  ['Yayın', [['environments', 'Ortamlar'], ['deployments', 'Deployment\'lar'], ['versions', 'Versiyonlar'], ['database', 'Veritabanı'], ['secrets', 'Secret\'lar', 'secret.manage']]],
  ['Zeka', [['ai', 'AI asistanı'], ['security', 'Güvenlik', 'security.read'], ['dependencies', 'Bağımlılıklar'], ['logs', 'Loglar'], ['incidents', 'Olaylar']]],
  ['Bilgi', [['docs', 'Dokümantasyon'], ['guide', 'Sunum ve kılavuz'], ['integrations', 'Entegrasyonlar'], ['settings', 'Ayarlar ve üyeler']]],
];

export default function ProjectLayout({ children }: { children: ReactNode }) {
  const slug = useProjectSlug();
  const pathname = usePathname();
  const project = useProject();
  if (project.isLoading) return <Loading label="Proje yükleniyor…" />;
  if (project.error || !project.data) return <div className="page"><ErrorState error={project.error} onRetry={() => void project.refetch()} /></div>;
  const p = project.data;
  const can = (perm: Permission) => p.permissions.includes(perm);
  const base = `/projects/${slug}`;
  const section = pathname.slice(base.length + 1).split('/')[0] ?? '';
  const archived = p.status === 'archived';
  const groups = NAV.map(([g, items]) => [g, items.filter(([, , perm]) => !perm || can(perm))] as const).filter(([, items]) => items.length);
  const activeGroup = groups.find(([, items]) => items.some(([key]) => key === section))?.[0] ?? groups[0]![0];

  return (
    <div className="page">
      <div className="p-head">
        <div className="p-title">
          <span className="p-logo" style={{ background: p.color }}>
            {p.name.slice(0, 2).toUpperCase()}
          </span>
          <div>
            <h1>{p.name}</h1>
            <div className="row" style={{ gap: 6, marginTop: 4 }}>
              <StatusBadge status={p.status} />
              {p.currentVersion && <span className="tag">v{p.currentVersion}</span>}
              <span className="tag">{p.defaultBranch}</span>
              {p.repository?.status === 'provisioning' && <StatusBadge status="provisioning" label="Repository hazırlanıyor" />}
              {p.repository?.status === 'failed' && <StatusBadge status="failed" label="Repository hatası" />}
              {p.customerName && <span className="small muted">{p.customerName}</span>}
            </div>
          </div>
        </div>
        <div className="row">
          <Link className="btn" href={`${base}/previews`}>
            <Eye /> Ön izleme
          </Link>
          <Link className="btn" href={`${base}/code`}>
            <Code2 /> Kod
          </Link>
          {can('review.create') && !archived && (
            <Link className="btn" href={`${base}/reviews?new=1`}>
              <Send /> Kullanıcıya gönder
            </Link>
          )}
          {(can('deployment.staging') || can('deployment.production')) && !archived && (
            <Link className="btn" href={`${base}/environments`}>
              <Rocket /> Deploy
            </Link>
          )}
          <Link className="btn pri" href={`${base}/ai`}>
            <Bot /> Proje AI&apos;ya sor
          </Link>
        </div>
      </div>
      {archived && <div className="warnbox" style={{ marginBottom: 14 }}>Bu proje arşivde. Kod, sürümler, dokümanlar ve denetim kayıtları korunur; build, ön izleme ve deployment kapalıdır.</div>}
      {p.repository?.status === 'failed' && <div className="badbox" style={{ marginBottom: 14 }}><b>Repository hazırlanamadı:</b> {p.repository.error}</div>}
      <nav className="p-tabs" aria-label="Proje menüsü">
        <div className="p-groups" role="tablist">
          {groups.map(([group, items]) => (
            <Link key={group} role="tab" aria-selected={group === activeGroup} href={items[0]![0] ? `${base}/${items[0]![0]}` : base} className={group === activeGroup ? 'on' : ''}>
              {group}
            </Link>
          ))}
        </div>
        <div className="p-pages">
          {(groups.find(([g]) => g === activeGroup)?.[1] ?? []).map(([key, label]) => (
            <Link key={key} href={key ? `${base}/${key}` : base} className={section === key ? 'on' : ''}>
              {label}
            </Link>
          ))}
        </div>
      </nav>
      <div style={{ minWidth: 0 }}>{children}</div>
    </div>
  );
}
