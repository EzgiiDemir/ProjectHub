'use client';

import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Archive,
  Bell,
  Bot,
  Folder,
  Gauge,
  HeartPulse,
  Home,
  KeyRound,
  Menu,
  Plus,
  Rocket,
  ScrollText,
  Search,
  Server,
  Shield,
  SunMoon,
  Users,
  Webhook,
} from 'lucide-react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useState, type ReactNode } from 'react';
import { api } from '@/lib/api';
import { ago } from '@/lib/format';
import { useMe } from '@/lib/hooks';
import { RealtimeBridge } from '@/lib/realtime';
import type { Notification, ProjectSummary } from '@/lib/types';
import { Avatar, ErrorState, Loading } from '../ui';
import { CommandPalette } from './command-palette';

export function AppShell({ children }: { children: ReactNode }) {
  const me = useMe();
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const pathname = usePathname();

  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setPaletteOpen((v) => !v);
      }
    };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, []);
  useEffect(() => setMenuOpen(false), [pathname]);

  if (me.isLoading) return <Loading label="Oturum doğrulanıyor…" />;
  if (me.error || !me.data) return <div className="page"><ErrorState error={me.error} onRetry={() => void me.refetch()} /></div>;

  return (
    <div className="app">
      <RealtimeBridge />
      <TopBar onPalette={() => setPaletteOpen(true)} onMenu={() => setMenuOpen((v) => !v)} />
      <Sidebar open={menuOpen} />
      <main className="main" id="main">
        {children}
      </main>
      {paletteOpen && <CommandPalette onClose={() => setPaletteOpen(false)} />}
    </div>
  );
}

function TopBar({ onPalette, onMenu }: { onPalette: () => void; onMenu: () => void }) {
  const me = useMe().data!;
  const router = useRouter();
  const qc = useQueryClient();
  const [open, setOpen] = useState<'notifications' | 'user' | null>(null);
  const notifications = useQuery({ queryKey: ['notifications'], queryFn: () => api<{ items: Notification[]; unread: number }>('/notifications'), refetchInterval: 120_000 });

  const toggleTheme = () => {
    const root = document.documentElement;
    const current = root.getAttribute('data-theme') ?? (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
    const next = current === 'dark' ? 'light' : 'dark';
    root.setAttribute('data-theme', next);
    try {
      localStorage.setItem('ph-theme', next);
    } catch {
      /* storage unavailable */
    }
  };

  async function switchOrg(id: string) {
    await api('/auth/switch-organization', { method: 'POST', body: { organizationId: id } });
    qc.clear();
    router.replace('/');
  }

  async function logout() {
    await api('/auth/logout', { method: 'POST' }).catch(() => undefined);
    qc.clear();
    window.location.href = '/login';
  }

  return (
    <header className="top">
      <button className="icon-btn menu-btn" onClick={onMenu} aria-label="Menüyü aç">
        <Menu size={20} />
      </button>
      <Link className="brand" href="/">
        <span className="brand-mark">PH</span>
        <span className="bt">Project Hub</span>
      </Link>
      {me.organizations.length > 1 ? (
        <select className="org" value={me.organization?.id} onChange={(e) => void switchOrg(e.target.value)} aria-label="Organizasyon">
          {me.organizations.map((o) => (
            <option key={o.id} value={o.id}>
              {o.name}
            </option>
          ))}
        </select>
      ) : (
        <span className="org">{me.organization?.name}</span>
      )}
      <button className="search-btn" onClick={onPalette}>
        <Search size={16} />
        <span>Proje, kod, feedback, deployment ara…</span>
        <kbd>Ctrl K</kbd>
      </button>
      <div className="top-actions">
        <button className="icon-btn" title="Bildirimler" onClick={() => setOpen(open === 'notifications' ? null : 'notifications')}>
          <Bell size={18} />
          {!!notifications.data?.unread && <span className="dot">{notifications.data.unread > 9 ? '9+' : notifications.data.unread}</span>}
        </button>
        <button className="icon-btn" title="Tema" onClick={toggleTheme}>
          <SunMoon size={18} />
        </button>
        <button className="icon-btn" title="Hesap" onClick={() => setOpen(open === 'user' ? null : 'user')}>
          <Avatar name={me.user.displayName} color={me.user.avatarColor} />
        </button>
      </div>
      {open === 'notifications' && (
        <div className="popover" onMouseLeave={() => setOpen(null)}>
          <div className="panel-h">
            <h2>Bildirimler</h2>
            <button
              className="btn sm ghost"
              onClick={async () => {
                await api('/notifications/read', { method: 'POST', body: { ids: null } });
                void qc.invalidateQueries({ queryKey: ['notifications'] });
              }}
            >
              Tümünü okundu say
            </button>
          </div>
          {notifications.data?.items.length ? (
            notifications.data.items.map((n) => (
              <Link
                key={n.id}
                className="list-item"
                href={n.link ?? '/'}
                onClick={() => {
                  setOpen(null);
                  void api('/notifications/read', { method: 'POST', body: { ids: [n.id] } }).then(() => qc.invalidateQueries({ queryKey: ['notifications'] }));
                }}
              >
                <span className="badge plain b-pri" style={{ opacity: n.readAt ? 0.4 : 1 }}>
                  {n.category}
                </span>
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontWeight: n.readAt ? 400 : 600, fontSize: 13 }}>{n.title}</div>
                  <div className="small muted">
                    {n.body ? `${n.body} · ` : ''}
                    {ago(n.createdAt)}
                  </div>
                </div>
              </Link>
            ))
          ) : (
            <div className="empty">
              <b>Bildirim yok</b>Size atanan işler ve onaylar burada görünür.
            </div>
          )}
        </div>
      )}
      {open === 'user' && (
        <div className="popover" style={{ width: 260 }} onMouseLeave={() => setOpen(null)}>
          <div style={{ padding: 14 }}>
            <b>{me.user.displayName}</b>
            <div className="small muted">{me.user.email}</div>
          </div>
          <hr style={{ margin: 0 }} />
          <Link className="list-item" href="/account" onClick={() => setOpen(null)}>
            Hesabım, oturumlar ve erişim tokenleri
          </Link>
          <button className="list-item" style={{ border: 0, background: 'transparent', width: '100%', cursor: 'pointer', textAlign: 'left' }} onClick={() => void logout()}>
            Çıkış yap
          </button>
        </div>
      )}
    </header>
  );
}

function Sidebar({ open }: { open: boolean }) {
  const pathname = usePathname();
  const me = useMe().data!;
  const can = (p: string) => me.permissions.includes(p as never);
  const projects = useQuery({ queryKey: ['projects', 'sidebar'], queryFn: () => api<ProjectSummary[]>('/projects?status=all') });
  const on = (href: string, exact = false) => (exact ? pathname === href : pathname === href || pathname.startsWith(`${href}/`)) ? 'on' : '';
  const active = (projects.data ?? []).filter((p) => p.status !== 'archived');
  const nav = (href: string, icon: ReactNode, label: string, extra?: ReactNode, exact = false) => (
    <Link href={href} className={on(href, exact)}>
      {icon}
      {label}
      {extra}
    </Link>
  );
  return (
    <nav className={`side ${open ? 'open' : ''}`} aria-label="Ana menü">
      <div className="nav">
        {nav('/', <Home />, 'Ana sayfa', null, true)}
        {nav('/projects', <Folder />, 'Projeler', <span className="cnt">{active.length || ''}</span>, true)}
        {nav('/archive', <Archive />, 'Proje arşivi')}
        {can('project.create') && nav('/projects/new', <Plus />, 'Proje ekle / içe aktar')}
        {nav('/deployments', <Rocket />, 'Deployment merkezi')}
        {nav('/security', <Shield />, 'Güvenlik merkezi')}
        <h6>Projelerim</h6>
        {active.slice(0, 20).map((p) => (
          <Link key={p.id} href={`/projects/${p.slug}`} className={on(`/projects/${p.slug}`)}>
            <span style={{ width: 16, height: 16, borderRadius: 4, background: p.color, flex: 'none' }} />
            <span className="ellipsis">{p.name}</span>
          </Link>
        ))}
        {!active.length && !projects.isLoading && <p className="small muted" style={{ padding: '0 10px' }}>Henüz projeniz yok.</p>}
        {(can('admin.users.manage') || can('admin.roles.manage') || can('admin.audit.read') || can('admin.system.read') || can('admin.settings.manage')) && (
          <>
            <h6>Yönetim</h6>
            {can('admin.users.manage') && nav('/admin/users', <Users />, 'Kullanıcılar ve ekipler')}
            {can('admin.roles.manage') && nav('/admin/roles', <KeyRound />, 'Roller ve yetkiler')}
            {can('admin.system.read') && nav('/admin/system', <Server />, 'Altyapı ve sistem sağlığı')}
            {can('admin.settings.manage') && nav('/admin/ai', <Bot />, 'AI kontrol merkezi')}
            {can('admin.settings.manage') && nav('/admin/settings', <Gauge />, 'Saklama ve kapasite')}
            {can('admin.settings.manage') && nav('/admin/webhooks', <Webhook />, 'Webhook\'lar')}
            {can('admin.audit.read') && nav('/admin/audit', <ScrollText />, 'Denetim kaydı')}
          </>
        )}
        <h6>Durum</h6>
        <SystemPulse />
      </div>
    </nav>
  );
}

function SystemPulse() {
  const ai = useQuery({ queryKey: ['aiStatus'], queryFn: () => api<{ configured: boolean; autonomyLevel: string }>('/ai/status'), staleTime: 300_000 });
  return (
    <div className="small muted" style={{ padding: '0 10px', display: 'grid', gap: 4 }}>
      <span className="row" style={{ gap: 6 }}>
        <HeartPulse size={14} /> API bağlı
      </span>
      <span className="row" style={{ gap: 6 }}>
        <Bot size={14} /> AI: {ai.data ? (ai.data.configured ? `etkin (${ai.data.autonomyLevel})` : 'yapılandırılmadı') : '…'}
      </span>
    </div>
  );
}
