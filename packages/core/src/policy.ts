import { deploymentWindowSchema, type DeploymentWindow, type EnvironmentType } from '@projecthub/contracts';

const DAY_NAMES = ['Pazar', 'Pazartesi', 'Salı', 'Çarşamba', 'Perşembe', 'Cuma', 'Cumartesi'];
const WEEKDAY: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
const minutes = (hhmm: string) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));

/** Deployment window stored in projects.settings.deploymentWindow (absent or invalid = no window). */
export function deploymentWindowOf(settings: Record<string, unknown> | null | undefined): DeploymentWindow | null {
  const parsed = deploymentWindowSchema.safeParse(settings?.deploymentWindow);
  return parsed.success && parsed.data.enabled ? parsed.data : null;
}

/** Day of week (0 = Sunday) and minute of day of `at` in the window's time zone. */
function localTime(at: Date, timeZone: string): { day: number; minute: number } {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone, weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(at).map((p) => [p.type, p.value]));
  return { day: WEEKDAY[parts.weekday!] ?? 0, minute: Number(parts.hour) * 60 + Number(parts.minute) };
}

/**
 * True when `at` falls inside the window. Overnight windows (start > end, e.g. 22:00–06:00) belong to the day they
 * start on: Friday 22:00–06:00 covers Friday night and early Saturday.
 */
export function isWithinDeploymentWindow(w: DeploymentWindow, at: Date = new Date()): boolean {
  const { day, minute } = localTime(at, w.timezone);
  const start = minutes(w.start);
  const end = minutes(w.end);
  if (start < end) return w.days.includes(day) && minute >= start && minute < end;
  if (minute >= start) return w.days.includes(day);
  return minute < end && w.days.includes((day + 6) % 7);
}

export function describeDeploymentWindow(w: DeploymentWindow): string {
  const days = [...w.days].sort((a, b) => ((a + 6) % 7) - ((b + 6) % 7)).map((d) => DAY_NAMES[d]).join(', ');
  return `${days} ${w.start}–${w.end} (${w.timezone})`;
}

export type WindowDecision = { status: 'inside' | 'not_applicable' } | { status: 'outside'; action: 'require_approval' | 'deny'; message: string };

/**
 * Policy decision for a deployment into an environment of type `envType`. Rollbacks are never denied by the window
 * (a night-time incident must be recoverable) — at most they need an approval.
 */
export function deploymentWindowDecision(settings: Record<string, unknown> | null | undefined, envType: EnvironmentType, opts: { at?: Date; isRollback?: boolean } = {}): WindowDecision {
  const w = deploymentWindowOf(settings);
  if (!w || !w.environmentTypes.includes(envType)) return { status: 'not_applicable' };
  if (isWithinDeploymentWindow(w, opts.at)) return { status: 'inside' };
  const action = w.outside === 'deny' && !opts.isRollback ? 'deny' : 'require_approval';
  const base = `Deployment zaman penceresi dışında (izinli: ${describeDeploymentWindow(w)})`;
  return { status: 'outside', action, message: action === 'deny' ? `${base}; bu saatte deployment yapılamaz.` : `${base}; yönetici onayı gerekiyor.` };
}
