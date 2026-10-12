/** Turkish labels and visual tones for every status vocabulary (one place, consistent everywhere — spec §146). */
export type Tone = 'ok' | 'warn' | 'bad' | 'run' | 'amber' | 'pri' | 'idle';

const L: Record<string, [string, Tone]> = {
  // generic / projects
  active: ['Aktif', 'ok'],
  maintenance: ['Bakımda', 'warn'],
  paused: ['Durduruldu', 'idle'],
  archived: ['Arşivlendi', 'idle'],
  invited: ['Davet edildi', 'amber'],
  suspended: ['Askıda', 'bad'],
  provisioning: ['Hazırlanıyor', 'run'],
  ready: ['Hazır', 'ok'],
  // builds & steps
  queued: ['Kuyrukta', 'idle'],
  running: ['Çalışıyor', 'run'],
  passed: ['Başarılı', 'ok'],
  failed: ['Başarısız', 'bad'],
  cancelled: ['İptal edildi', 'idle'],
  pending: ['Bekliyor', 'idle'],
  skipped: ['Atlandı', 'idle'],
  // previews
  starting: ['Başlatılıyor', 'run'],
  stopped: ['Durduruldu', 'idle'],
  expired: ['Süresi doldu', 'idle'],
  // reviews
  revoked: ['Kapatıldı', 'idle'],
  // feedback
  open: ['Açık', 'warn'],
  triaged: ['İncelendi', 'run'],
  planned: ['Planlandı', 'run'],
  in_progress: ['Üzerinde çalışılıyor', 'run'],
  ready_for_review: ['Kullanıcı onayında', 'amber'],
  resolved: ['Çözüldü', 'ok'],
  rejected: ['Reddedildi', 'idle'],
  // tasks
  todo: ['Yapılacak', 'idle'],
  in_review: ['İncelemede', 'amber'],
  done: ['Tamamlandı', 'ok'],
  // environments
  unknown: ['Bilinmiyor', 'idle'],
  healthy: ['Sağlıklı', 'ok'],
  degraded: ['Yavaş / sorunlu', 'warn'],
  down: ['Erişilemiyor', 'bad'],
  // versions
  draft: ['Taslak', 'idle'],
  released: ['Yayınlandı', 'ok'],
  rolled_back: ['Geri alındı', 'warn'],
  deprecated: ['Kullanımdan kalktı', 'idle'],
  // deployments
  pending_approval: ['Onay bekliyor', 'amber'],
  succeeded: ['Tamamlandı', 'ok'],
  // security
  critical: ['Kritik', 'bad'],
  high: ['Yüksek', 'bad'],
  medium: ['Orta', 'warn'],
  low: ['Düşük', 'idle'],
  info: ['Bilgi', 'idle'],
  accepted: ['Risk kabul edildi', 'idle'],
  false_positive: ['Yanlış alarm', 'idle'],
  completed: ['Tamamlandı', 'ok'],
  // AI
  awaiting_approval: ['Onay bekliyor', 'amber'],
  merged: ['Birleştirildi', 'ok'],
  // jobs
  approved: ['Onaylandı', 'ok'],
};

export function statusLabel(s: string | null | undefined): string {
  if (!s) return '—';
  return L[s]?.[0] ?? s;
}
export function statusTone(s: string | null | undefined): Tone {
  if (!s) return 'idle';
  return L[s]?.[1] ?? 'idle';
}

export const FEEDBACK_TYPE: Record<string, string> = { comment: 'Yorum', bug: 'Hata', change_request: 'Değişiklik talebi' };
export const PRIORITY: Record<string, string> = { low: 'Düşük', medium: 'Orta', high: 'Yüksek', critical: 'Kritik' };
export const ENV_TYPE: Record<string, string> = { development: 'Development', staging: 'Staging', production: 'Production', custom: 'Özel' };
export const ADAPTER: Record<string, string> = { local: 'Sunucu klasörü', sftp: 'SFTP', ftp: 'FTP / FTPS', ssh: 'SSH (SFTP + komut)' };
export const FINDING_TYPE: Record<string, string> = { secret: 'Secret', dependency: 'Bağımlılık', code: 'Kod', config: 'Yapılandırma' };
export const EVENT_KIND: Record<string, [string, string]> = {
  project: ['Proje', 'var(--muted)'],
  commit: ['Commit', 'var(--idle)'],
  build: ['Build', 'var(--run)'],
  preview: ['Ön izleme', 'var(--run)'],
  review: ['Kullanıcı linki', 'var(--primary)'],
  feedback: ['Feedback', 'var(--amber)'],
  task: ['Görev', 'var(--primary)'],
  ai: ['AI', '#7a3ea8'],
  deploy: ['Deployment', 'var(--ok)'],
  version: ['Versiyon', 'var(--ok)'],
  security: ['Güvenlik', 'var(--warn)'],
  incident: ['Olay', 'var(--bad)'],
  docs: ['Doküman', 'var(--muted)'],
};
export const DEPARTMENTS = ['Pazarlama', 'Bilgi İşlem', 'E-Ticaret Operasyon', 'Kullanıcı Hizmetleri', 'Satış', 'Finans', 'Hukuk', 'Yönetim', 'Tasarım', 'Diğer'];
/** AI autonomy levels (spec: L0 off … L3 tries its change in a preview); production is never AI-deployed. */
export const AI_LEVEL: Record<string, string> = { L0: 'Kapalı', L1: 'Okur ve açıklar', L2: 'Değişiklik hazırlar, onay ister', L3: 'Değişikliği ön izlemede kendisi dener, onay ister' };
