'use client';

import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Archive,
  Bell,
  Bot,
  ChevronDown,
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
  UsersRound,
  Webhook,
  X,
} from 'lucide-react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { api } from '@/lib/api';
import { ago } from '@/lib/format';
import { useMe } from '@/lib/hooks';
import { RealtimeBridge } from '@/lib/realtime';
import type { Notification, ProjectSummary } from '@/lib/types';
import { ArucadLogo } from '../brand/logo';
import { Avatar, ErrorState, Loading } from '../ui';
import { CommandPalette } from './command-palette';

interface NavLink {
  href: string;
  label: string;
  icon: ReactNode;
  exact?: boolean;
}

/** Navigation model shared by the top bar and the mobile menu. */
function useNavigation() {
  const me = useMe().data!;
  const can = (p: string) => me.permissions.includes(p as never);
  const projects = useQuery({ queryKey: ['projects', 'sidebar'], queryFn: () => api<ProjectSummary[]>('/projects?status=all') });
  const active = (projects.data ?? []).filter((p) => p.status !== 'archived');
  const main: NavLink[] = [
    { href: '/', label: 'Ana sayfa', icon: <Home />, exact: true },
    { href: '/team', label: 'Takım çalışması', icon: <UsersRound /> },
    { href: '/deployments', label: 'Deployment', icon: <Rocket /> },
    { href: '/security', label: 'Güvenlik', icon: <Shield /> },
  ];
  const projectLinks: NavLink[] = [
    { href: '/projects', label: 'Tüm projeler', icon: <Folder />, exact: true },
    ...(can('project.create') ? [{ href: '/projects/new', label: 'Proje ekle / içe aktar', icon: <Plus /> }] : []),
    { href: '/archive', label: 'Proje arşivi', icon: <Archive /> },
  ];
  const admin: NavLink[] = [
    ...(can('admin.users.manage') ? [{ href: '/admin/users', label: 'Kullanıcılar ve ekipler', icon: <Users /> }] : []),
    ...(can('admin.roles.manage') ? [{ href: '/admin/roles', label: 'Roller ve yetkiler', icon: <KeyRound /> }] : []),
    ...(can('admin.system.read') ? [{ href: '/admin/system', label: 'Altyapı ve sistem sağlığı', icon: <Server /> }] : []),
    ...(can('admin.settings.manage')
      ? [
          { href: '/admin/ai', label: 'AI kontrol merkezi', icon: <Bot /> },
          { href: '/admin/settings', label: 'Saklama ve kapasite', icon: <Gauge /> },
          { href: '/admin/webhooks', label: "Webhook'lar", icon: <Webhook /> },
        ]
      : []),
    ...(can('admin.audit.read') ? [{ href: '/admin/audit', label: 'Denetim kaydı', icon: <ScrollText /> }] : []),
  ];
  return { main, projectLinks, admin, projects: active, loadingProjects: projects.isLoading };
}

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
      <TopBar onPalette={() => setPaletteOpen(true)} onMenu={() => setMenuOpen(true)} />
      {menuOpen && <MobileMenu onClose={() => setMenuOpen(false)} />}
      <main className="main" id="main">
        <div className="main-inner">{children}</div>
        <StatusBar />
      </main>
      {paletteOpen && <CommandPalette onClose={() => setPaletteOpen(false)} />}
    </div>
  );
}

/** A top-bar menu button that opens a dropdown; closes on outside click, Escape and navigation. */
function Dropdown({ label, active, children, align = 'left' }: { label: ReactNode; active: boolean; children: ReactNode; align?: 'left' | 'right' }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const pathname = usePathname();
  useEffect(() => setOpen(false), [pathname]);
  useEffect(() => {
    if (!open) return;
    const click = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    const key = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('mousedown', click);
    document.addEventListener('keydown', key);
    return () => {
      document.removeEventListener('mousedown', click);
      document.removeEventListener('keydown', key);
    };
  }, [open]);
  return (
    <div className="dd" ref={ref}>
      <button className={`top-link ${active ? 'on' : ''}`} aria-expanded={open} onClick={() => setOpen((v) => !v)}>
        {label} <ChevronDown size={14} />
      </button>
      {open && <div className={`dd-menu ${align}`}>{children}</div>}
    </div>
  );
}

function TopBar({ onPalette, onMenu }: { onPalette: () => void; onMenu: () => void }) {
  const me = useMe().data!;
  const router = useRouter();
  const qc = useQueryClient();
  const pathname = usePathname();
  const nav = useNavigation();
  const [open, setOpen] = useState<'notifications' | 'user' | null>(null);
  const notifications = useQuery({ queryKey: ['notifications'], queryFn: () => api<{ items: Notification[]; unread: number }>('/notifications'), refetchInterval: 120_000 });
  const isOn = (l: NavLink) => (l.exact ? pathname === l.href : pathname === l.href || pathname.startsWith(`${l.href}/`));

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
      <Link className="brand" href="/" aria-label="Project Hub ana sayfa">
        <ArucadLogo height={22} priority />
        <span className="bt">Project Hub</span>
      </Link>
      <nav className="top-nav" aria-label="Ana menü">
        {nav.main.slice(0, 1).map((l) => (
          <Link key={l.href} href={l.href} className={`top-link ${isOn(l) ? 'on' : ''}`}>
            {l.label}
          </Link>
        ))}
        <Dropdown label="Projeler" active={pathname.startsWith('/projects') || pathname === '/archive'}>
          {nav.projectLinks.map((l) => (
            <Link key={l.href} href={l.href} className="dd-item">
              {l.icon} {l.label}
            </Link>
          ))}
          {nav.projects.length > 0 && <div className="dd-head">Projelerim</div>}
          <div className="dd-scroll">
            {nav.projects.slice(0, 30).map((p) => (
              <Link key={p.id} href={`/projects/${p.slug}`} className={`dd-item ${pathname.startsWith(`/projects/${p.slug}`) ? 'on' : ''}`}>
                <span className="dd-swatch" style={{ background: p.color }} />
                <span className="ellipsis">{p.name}</span>
              </Link>
            ))}
          </div>
        </Dropdown>
        {nav.main.slice(1).map((l) => (
          <Link key={l.href} href={l.href} className={`top-link ${isOn(l) ? 'on' : ''}`}>
            {l.label}
          </Link>
        ))}
        {nav.admin.length > 0 && (
          <Dropdown label="Yönetim" active={pathname.startsWith('/admin')}>
            {nav.admin.map((l) => (
              <Link key={l.href} href={l.href} className={`dd-item ${isOn(l) ? 'on' : ''}`}>
                {l.icon} {l.label}
              </Link>
            ))}
          </Dropdown>
        )}
      </nav>
      <div className="top-actions">
        <button className="search-btn" onClick={onPalette} aria-label="Ara (Ctrl K)">
          <Search size={16} />
          <span>Ara…</span>
          <kbd>Ctrl K</kbd>
        </button>
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
        <div className="popover" style={{ width: 280 }} onMouseLeave={() => setOpen(null)}>
          <div style={{ padding: 14 }}>
            <b>{me.user.displayName}</b>
            <div className="small muted">{me.user.email}</div>
          </div>
          {me.organizations.length > 1 ? (
            <div style={{ padding: '0 14px 12px' }}>
              <select className="in" value={me.organization?.id} onChange={(e) => void switchOrg(e.target.value)} aria-label="Organizasyon">
                {me.organizations.map((o) => (
                  <option key={o.id} value={o.id}>
                    {o.name}
                  </option>
                ))}
              </select>
            </div>
          ) : (
            <div className="small muted" style={{ padding: '0 14px 12px' }}>
              {me.organization?.name}
            </div>
          )}
          <hr style={{ margin: 0 }} />
          <Link className="list-item" href="/account" onClick={() => setOpen(null)}>
            Hesabım, bildirimler ve erişim tokenleri
          </Link>
          <button className="list-item" style={{ border: 0, background: 'transparent', width: '100%', cursor: 'pointer', textAlign: 'left' }} onClick={() => void logout()}>
            Çıkış yap
          </button>
        </div>
      )}
    </header>
  );
}

/** Small screens: the same navigation as a full-height drawer. */
function MobileMenu({ onClose }: { onClose: () => void }) {
  const nav = useNavigation();
  const pathname = usePathname();
  const item = (l: NavLink) => (
    <Link key={l.href} href={l.href} className={`dd-item ${(l.exact ? pathname === l.href : pathname.startsWith(l.href)) ? 'on' : ''}`}>
      {l.icon} {l.label}
    </Link>
  );
  return (
    <div className="mobile-menu" role="dialog" aria-modal="true" aria-label="Menü">
      <div className="mobile-menu-head">
        <ArucadLogo height={22} />
        <button className="icon-btn" onClick={onClose} aria-label="Menüyü kapat">
          <X size={20} />
        </button>
      </div>
      {nav.main.map(item)}
      <div className="dd-head">Projeler</div>
      {nav.projectLinks.map(item)}
      {nav.projects.slice(0, 20).map((p) => (
        <Link key={p.id} href={`/projects/${p.slug}`} className="dd-item">
          <span className="dd-swatch" style={{ background: p.color }} />
          <span className="ellipsis">{p.name}</span>
        </Link>
      ))}
      {nav.admin.length > 0 && <div className="dd-head">Yönetim</div>}
      {nav.admin.map(item)}
    </div>
  );
}

/** Bottom status bar: live system state and the developer credit. */
function StatusBar() {
  const ai = useQuery({ queryKey: ['aiStatus'], queryFn: () => api<{ configured: boolean; autonomyLevel: string }>('/ai/status'), staleTime: 300_000 });
  return (
    <footer className="status-bar">
      <span className="status-title">Durum</span>
      <span className="row" style={{ gap: 6 }}>
        <HeartPulse size={14} /> API bağlı
      </span>
      <span className="row" style={{ gap: 6 }}>
        <Bot size={14} /> AI: {ai.data ? (ai.data.configured ? `etkin (${ai.data.autonomyLevel})` : 'yapılandırılmadı') : '…'}
      </span>
      <span className="credit">Veri Sistemleri Birimi tarafından geliştirilmiştir</span>
    </footer>
  );
}
